#!/usr/bin/env node
import { z } from "zod";
import { fieldDesc, isBoolean, parseArgs, typeHint } from "./cli-args.js";
import { start as startMcp } from "./mcp.js";
import { installSkills } from "./skill-install.js";
import { TOOLS, getTool, ToolDef } from "./tools.js";
import { LspPool } from "./workspace.js";

const VERBOSE = process.env.TSLSP_VERBOSE === "1" || process.env.TSLSP_MCP_VERBOSE === "1";

export async function runCli(argv: string[]): Promise<number> {
  const args = [...argv];
  if (!args.length || args[0] === "--help" || args[0] === "-h" || args[0] === "help") {
    process.stdout.write(rootHelp() + "\n");
    return 0;
  }
  if (args[0] === "--version" || args[0] === "-v") {
    process.stdout.write(`${(await readVersion()) ?? "unknown"}\n`);
    return 0;
  }

  const cmd = args.shift()!;

  if (cmd === "install") {
    return runInstall(args);
  }
  if (cmd === "mcp" || cmd === "serve") {
    await startMcp(); // resolves on SIGINT/SIGTERM; do NOT process.exit before that.
    return 0;
  }

  const tool = getTool(cmd);
  if (!tool) {
    process.stderr.write(`unknown command: ${cmd}\n\n${rootHelp()}\n`);
    return 2;
  }
  return runTool(tool, args);
}

async function runInstall(argv: string[]): Promise<number> {
  if (argv.includes("--help") || argv.includes("-h")) {
    process.stdout.write(installHelp() + "\n");
    return 0;
  }
  if (!argv.includes("--skills")) {
    process.stderr.write(`install requires --skills\n\n${installHelp()}\n`);
    return 2;
  }
  const scope: "user" | "project" = argv.includes("--project") || argv.includes("--local") ? "project" : "user";
  const force = argv.includes("--force");
  const result = await installSkills({ scope, force });
  for (const line of result.lines) process.stdout.write(line + "\n");
  return result.ok ? 0 : 1;
}

async function runTool(tool: ToolDef, argv: string[]): Promise<number> {
  if (argv.includes("--help") || argv.includes("-h")) {
    process.stdout.write(toolHelp(tool) + "\n");
    return 0;
  }
  let parsed: Record<string, unknown>;
  try {
    parsed = parseArgs(tool, argv);
  } catch (e) {
    process.stderr.write(`${(e as Error).message}\n\n${toolHelp(tool)}\n`);
    return 2;
  }

  // Validate against the tool's zod schema so CLI users get the same
  // constraint checks as MCP clients (e.g. `.min(1)`, `.positive()`,
  // `.max(200)`). Without this the CLI path silently bypassed them.
  let validated: Record<string, unknown>;
  try {
    const schema = z.object(tool.inputSchema as z.ZodRawShape);
    validated = schema.parse(parsed) as Record<string, unknown>;
  } catch (e) {
    const msg = e instanceof z.ZodError ? formatZodError(e) : (e as Error).message;
    process.stderr.write(`${msg}\n\n${toolHelp(tool)}\n`);
    return 2;
  }

  const log = VERBOSE ? (line: string) => process.stderr.write(line + "\n") : undefined;
  const pool = new LspPool(log);
  try {
    const out = await tool.handler(validated as any, { pool, cwd: process.cwd() });
    const stream = out.isError ? process.stderr : process.stdout;
    stream.write(out.text + (out.text.endsWith("\n") ? "" : "\n"));
    return out.isError ? 1 : 0;
  } finally {
    await pool.disposeAll();
  }
}

function formatZodError(e: z.ZodError): string {
  return e.issues
    .map((iss) => {
      const path = iss.path.length ? iss.path.join(".") : "<arg>";
      return `invalid --${String(path).replace(/_/g, "-")}: ${iss.message}`;
    })
    .join("\n");
}

// --- help ---

export function rootHelp(): string {
  const lines = [
    "tslsp — type-aware TypeScript code intelligence CLI",
    "",
    "usage:",
    "  tslsp <command> [args]",
    "  tslsp install --skills [--project] [--force]",
    "  tslsp mcp                       start MCP server (stdio)",
    "  tslsp <command> --help          per-command help",
    "",
    "commands:",
  ];
  const width = Math.max(...TOOLS.map((t) => t.name.length));
  for (const t of TOOLS) {
    lines.push(`  ${t.name.padEnd(width)}  ${t.description}`);
  }
  lines.push("");
  lines.push("global flags:");
  lines.push("  --help, -h     show this message");
  lines.push("  --version, -v  print version");
  lines.push("");
  lines.push("env:");
  lines.push("  TSLSP_VERBOSE=1  forward tsgo stderr to stderr");
  return lines.join("\n");
}

export function toolHelp(tool: ToolDef): string {
  const shape = tool.inputSchema as Record<string, z.ZodTypeAny>;
  const positional = (tool.positional ?? []) as string[];
  const flags = Object.keys(shape).filter((k) => !positional.includes(k));
  const lines: string[] = [];
  const posStr = positional.map((p) => `<${p.replace(/_/g, "-")}>`).join(" ");
  lines.push(`tslsp ${tool.name.replace(/_/g, "-")} ${posStr} [flags]`);
  lines.push("");
  lines.push(tool.description);
  if (positional.length) {
    lines.push("");
    lines.push("arguments:");
    for (const k of positional) lines.push(`  ${k.replace(/_/g, "-").padEnd(18)}  ${fieldDesc(shape[k]!)}`);
  }
  if (flags.length) {
    lines.push("");
    lines.push("flags:");
    for (const k of flags) {
      const ty = shape[k]!;
      const hint = isBoolean(ty) ? "" : ` <${typeHint(ty)}>`;
      lines.push(`  --${k.replace(/_/g, "-")}${hint.padEnd(Math.max(0, 18 - k.length - hint.length))}  ${fieldDesc(ty)}`);
    }
  }
  return lines.join("\n");
}

function installHelp(): string {
  return [
    "tslsp install --skills [--project] [--force]",
    "",
    "Install the tslsp skill so Claude Code (and other skill-aware agents) can",
    "discover it and route TypeScript navigation/refactor work through this CLI.",
    "",
    "flags:",
    "  --skills    required. install the bundled SKILL.md.",
    "  --project   install into ./.claude/skills (default: ~/.claude/skills).",
    "  --local     alias for --project.",
    "  --force     overwrite an existing skill at the target.",
  ].join("\n");
}

async function readVersion(): Promise<string | undefined> {
  try {
    const { readFile } = await import("node:fs/promises");
    const { fileURLToPath } = await import("node:url");
    const { join, dirname } = await import("node:path");
    const here = fileURLToPath(new URL(".", import.meta.url));
    const pkg = JSON.parse(await readFile(join(dirname(here), "..", "package.json"), "utf8"));
    return pkg.version;
  } catch {
    return undefined;
  }
}

// Only run when invoked as a binary, not when imported by tests.
const invokedDirectly = (() => {
  if (!process.argv[1]) return false;
  const arg1 = process.argv[1];
  return arg1.endsWith("/cli.js") || arg1.endsWith("\\cli.js") || arg1.endsWith("/tslsp");
})();

if (invokedDirectly) {
  runCli(process.argv.slice(2))
    .then((code) => process.exit(code))
    .catch((e) => {
      process.stderr.write(`tslsp fatal: ${e?.stack ?? e}\n`);
      process.exit(1);
    });
}
