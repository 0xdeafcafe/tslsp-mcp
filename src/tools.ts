import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { isAbsolute, resolve } from "node:path";
import { z } from "zod";
import {
  formatDiagnostic,
  formatHover,
  formatLocations,
  formatOutline,
  kindName,
  uriToRel,
} from "./format.js";
import {
  DocumentSymbol,
  Hover,
  Location,
  SymbolInformation,
  WorkspaceEdit,
} from "./lsp-client.js";
import { LocatorError, resolveLocator, SymbolLocator } from "./locator.js";
import { applyWorkspaceEdit, summarizeRename } from "./rename.js";
import { LspPool } from "./workspace.js";

const locatorShape = {
  file: z.string().optional().describe("File path. Required with line/character or for line+symbol mode."),
  line: z.number().int().nonnegative().optional().describe("Zero-based line number."),
  character: z.number().int().nonnegative().optional().describe("Zero-based column. Use with line."),
  symbol: z.string().optional().describe("Identifier text. With file+line: scans the line. Alone: workspace-wide search."),
};

type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean };

function text(s: string): ToolResult {
  return { content: [{ type: "text", text: s }] };
}

function err(s: string): ToolResult {
  return { content: [{ type: "text", text: s }], isError: true };
}

function abs(p: string, cwd = process.cwd()): string {
  return isAbsolute(p) ? p : resolve(cwd, p);
}

async function withLocator(
  pool: LspPool,
  loc: SymbolLocator,
  fn: (r: Awaited<ReturnType<typeof resolveLocator>>) => Promise<ToolResult>,
): Promise<ToolResult> {
  try {
    const resolved = await resolveLocator(pool, loc);
    return await fn(resolved);
  } catch (e) {
    if (e instanceof LocatorError) {
      let msg = e.message;
      if (e.candidates?.length) {
        msg += "\nCandidates:";
        for (const c of e.candidates.slice(0, 20)) {
          const where = c.location.uri.replace(/^file:\/\//, "");
          msg += `\n  ${kindName(c.kind)} ${c.name} — ${where}:${c.location.range.start.line + 1}`;
        }
      }
      return err(msg);
    }
    return err(String((e as Error).message ?? e));
  }
}

export function registerTools(server: McpServer, pool: LspPool): void {
  server.registerTool(
    "find_symbol",
    {
      title: "find_symbol",
      description:
        "Search the workspace for symbols by name (function, class, interface, variable). Returns each match's path, line, and kind. Use this first when you only know a symbol by name.",
      inputSchema: {
        query: z.string().min(1).describe("Substring to search; tsgo does fuzzy matching."),
        file: z
          .string()
          .optional()
          .describe("Optional: restrict to symbols declared in this file."),
        limit: z.number().int().positive().max(200).optional().describe("Default 50."),
      },
    },
    async ({ query, file, limit }) => {
      const cwd = process.cwd();
      try {
        const probePath = file ? abs(file, cwd) : cwd;
        const { client, root } = file
          ? await pool.forFile(probePath)
          : await (async () => {
              const c = await pool.forFile(probePath).catch(() => null);
              return c ?? { client: await pool.forRoot(probePath), root: probePath };
            })();
        const matches = ((await client.request<SymbolInformation[] | null>("workspace/symbol", { query })) ?? []).slice(0, limit ?? 50);
        if (file) {
          const targetUri = abs(file, cwd);
          const filtered = matches.filter((s) => s.location.uri.endsWith(targetUri));
          return text(renderSymbolList(filtered.length ? filtered : matches, root));
        }
        return text(renderSymbolList(matches, root));
      } catch (e) {
        return err(String((e as Error).message ?? e));
      }
    },
  );

  server.registerTool(
    "references",
    {
      title: "references",
      description:
        "Find all references to the symbol at a given position. Most accurate way to see where something is used. Accepts position OR { file, line, symbol } OR { symbol }.",
      inputSchema: {
        ...locatorShape,
        include_declaration: z.boolean().optional().describe("Include the declaration site. Default true."),
        limit: z.number().int().positive().max(500).optional().describe("Default 200."),
      },
    },
    async ({ include_declaration, limit, ...loc }) =>
      withLocator(pool, loc as SymbolLocator, async ({ client, root, uri, position }) => {
        const refs = (await client.request<Location[] | null>("textDocument/references", {
          textDocument: { uri },
          position,
          context: { includeDeclaration: include_declaration ?? true },
        })) ?? [];
        if (!refs.length) return text("no references");
        const f = await formatLocations(refs, root, limit ?? 200);
        return text(f.text);
      }),
  );

  server.registerTool(
    "definition",
    {
      title: "definition",
      description:
        "Jump to where the symbol at this position is defined. Accepts position OR { file, line, symbol } OR { symbol }.",
      inputSchema: locatorShape,
    },
    async (loc) =>
      withLocator(pool, loc as SymbolLocator, async ({ client, root, uri, position }) => {
        const result = await client.request<Location | Location[] | null>("textDocument/definition", {
          textDocument: { uri },
          position,
        });
        const arr = !result ? [] : Array.isArray(result) ? result : [result];
        if (!arr.length) return text("no definition");
        const f = await formatLocations(arr, root, 20);
        return text(f.text);
      }),
  );

  server.registerTool(
    "rename",
    {
      title: "rename",
      description:
        "Rename a symbol across all files where it's referenced. Type-aware. Pass dry_run: true to preview without writing. Accepts position OR { file, line, symbol } OR { symbol }.",
      inputSchema: {
        ...locatorShape,
        new_name: z.string().min(1).describe("The new identifier."),
        dry_run: z.boolean().optional().describe("If true, return a preview without modifying files."),
      },
    },
    async ({ new_name, dry_run, ...loc }) =>
      withLocator(pool, loc as SymbolLocator, async ({ client, root, uri, position }) => {
        const edit = await client.request<WorkspaceEdit | null>("textDocument/rename", {
          textDocument: { uri },
          position,
          newName: new_name,
        });
        if (!edit || (!edit.changes && !edit.documentChanges)) {
          return text("no rename available at this position");
        }
        if (dry_run) {
          const summary = await summarizeRename(edit, root, true);
          return text(renderRenameSummary(summary, true));
        }
        const summary = await applyWorkspaceEdit(client, edit, root);
        return text(renderRenameSummary(summary, false));
      }),
  );

  server.registerTool(
    "hover",
    {
      title: "hover",
      description:
        "Get the type signature and JSDoc for the symbol at a position. Accepts position OR { file, line, symbol } OR { symbol }.",
      inputSchema: locatorShape,
    },
    async (loc) =>
      withLocator(pool, loc as SymbolLocator, async ({ client, uri, position }) => {
        const h = await client.request<Hover | null>("textDocument/hover", {
          textDocument: { uri },
          position,
        });
        return text(formatHover(h));
      }),
  );

  server.registerTool(
    "outline",
    {
      title: "outline",
      description: "Hierarchical outline of declarations in a file. Useful before diving into a large file.",
      inputSchema: {
        file: z.string().describe("File path."),
      },
    },
    async ({ file }) => {
      const filePath = abs(file);
      try {
        const { client } = await pool.forFile(filePath);
        const uri = await client.syncOpen(filePath);
        const result = await client.request<DocumentSymbol[] | SymbolInformation[] | null>(
          "textDocument/documentSymbol",
          { textDocument: { uri } },
        );
        if (!result || !result.length) return text("(empty)");
        // tsgo returns DocumentSymbol[] when hierarchicalDocumentSymbolSupport is true.
        if ("range" in result[0]!) {
          return text(formatOutline(result as DocumentSymbol[]));
        }
        // Flat fallback.
        const flat = result as SymbolInformation[];
        return text(flat.map((s) => `${kindName(s.kind)} ${s.name}  (line ${s.location.range.start.line + 1})`).join("\n"));
      } catch (e) {
        return err(String((e as Error).message ?? e));
      }
    },
  );

  server.registerTool(
    "diagnostics",
    {
      title: "diagnostics",
      description:
        "Type errors and warnings. Pass a file to scope; omit to scan all opened files in the project.",
      inputSchema: {
        file: z.string().optional().describe("File path. Omit to report across all opened files in this MCP session."),
        severity: z
          .enum(["error", "warning", "info", "all"])
          .optional()
          .describe("Filter by severity. Default: error+warning."),
      },
    },
    async ({ file, severity }) => {
      try {
        const minSev = severityFilter(severity ?? "warning");
        if (file) {
          const filePath = abs(file);
          const { client, root } = await pool.forFile(filePath);
          const uri = await client.syncOpen(filePath);
          // tsgo publishes diagnostics asynchronously; wait briefly if none yet.
          await waitForDiagnostics(() => client.diagnosticsFor(uri), 2000);
          const diags = (client.diagnosticsFor(uri) ?? []).filter((d) => (d.severity ?? 1) <= minSev);
          if (!diags.length) return text("no diagnostics");
          return text(diags.map((d) => formatDiagnostic(d, uriToRel(uri, root))).join("\n"));
        }
        // No file given — aggregate from every open URI across every pool client.
        const lines: string[] = [];
        for (const root of pool.roots()) {
          const client = await pool.forRoot(root);
          for (const [uri, diags] of client.diagnosticsAll()) {
            const filtered = diags.filter((d) => (d.severity ?? 1) <= minSev);
            for (const d of filtered) lines.push(formatDiagnostic(d, uriToRel(uri, root)));
          }
        }
        return text(lines.length ? lines.join("\n") : "no diagnostics");
      } catch (e) {
        return err(String((e as Error).message ?? e));
      }
    },
  );
}

function severityFilter(sev: "error" | "warning" | "info" | "all"): number {
  if (sev === "error") return 1;
  if (sev === "warning") return 2;
  if (sev === "info") return 3;
  return 4;
}

async function waitForDiagnostics(read: () => unknown, ms: number): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (read() !== undefined) return;
    await new Promise((r) => setTimeout(r, 50));
  }
}

function renderSymbolList(matches: SymbolInformation[], root: string): string {
  if (!matches.length) return "no matches";
  return matches
    .map((s) => {
      const where = uriToRel(s.location.uri, root);
      const line = s.location.range.start.line + 1;
      const container = s.containerName ? `  (${s.containerName})` : "";
      return `${where}:${line}  ${kindName(s.kind)} ${s.name}${container}`;
    })
    .join("\n");
}

function renderRenameSummary(s: { files_changed: number; total_edits: number; files: string[]; preview?: string }, dryRun: boolean): string {
  const head = dryRun
    ? `[preview] would change ${s.total_edits} site${s.total_edits === 1 ? "" : "s"} across ${s.files_changed} file${s.files_changed === 1 ? "" : "s"}`
    : `changed ${s.total_edits} site${s.total_edits === 1 ? "" : "s"} across ${s.files_changed} file${s.files_changed === 1 ? "" : "s"}`;
  const fileList = s.files.map((f) => `  ${f}`).join("\n");
  const preview = s.preview ? `\n\n${s.preview}` : "";
  return `${head}\n${fileList}${preview}`;
}
