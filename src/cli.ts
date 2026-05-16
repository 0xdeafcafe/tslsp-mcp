#!/usr/bin/env node
import { z } from "zod";
import { installSkills } from "./skill-install.js";
import { TOOLS, getTool, ToolDef } from "./tools.js";
import { LspPool } from "./workspace.js";

const VERBOSE = process.env.TSLSP_VERBOSE === "1" || process.env.TSLSP_MCP_VERBOSE === "1";

async function main(argv: string[]): Promise<number> {
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
    await import("./index.js");
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

  const log = VERBOSE ? (line: string) => process.stderr.write(line + "\n") : undefined;
  const pool = new LspPool(log);
  try {
    const out = await tool.handler(parsed as any, { pool, cwd: process.cwd() });
    const stream = out.isError ? process.stderr : process.stdout;
    stream.write(out.text + (out.text.endsWith("\n") ? "" : "\n"));
    return out.isError ? 1 : 0;
  } finally {
    await pool.disposeAll();
  }
}

// --- arg parsing ---

function parseArgs(tool: ToolDef, argv: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const shape = tool.inputSchema as Record<string, z.ZodTypeAny>;
  const positional = (tool.positional ?? []) as string[];
  let posIdx = 0;

  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i]!;
    if (tok.startsWith("--")) {
      const eq = tok.indexOf("=");
      const flag = (eq === -1 ? tok.slice(2) : tok.slice(2, eq)).replace(/-/g, "_");
      const inline = eq === -1 ? undefined : tok.slice(eq + 1);
      if (!(flag in shape)) throw new Error(`unknown flag: --${flag.replace(/_/g, "-")}`);
      const ty = shape[flag]!;
      if (isBoolean(ty)) {
        if (inline === undefined) out[flag] = true;
        else out[flag] = inline === "true" || inline === "1";
        continue;
      }
      const value = inline ?? argv[++i];
      if (value === undefined) throw new Error(`--${flag.replace(/_/g, "-")} requires a value`);
      if (isArray(ty)) {
        const parts = value.split(",").map((s) => s.trim()).filter(Boolean);
        const prev = (out[flag] as unknown[] | undefined) ?? [];
        out[flag] = [...prev, ...parts.map((p) => coerce(arrayInner(ty), p))];
      } else {
        out[flag] = coerce(ty, value);
      }
    } else {
      // Positional. If the last positional's schema is an array, fold every
      // remaining positional token into it.
      const cur = positional[posIdx];
      if (cur === undefined) throw new Error(`unexpected argument: ${tok}`);
      const ty = shape[cur];
      if (!ty) throw new Error(`positional maps to unknown flag: ${cur}`);
      if (isArray(ty)) {
        const prev = (out[cur] as unknown[] | undefined) ?? [];
        out[cur] = [...prev, coerce(arrayInner(ty), tok)];
        // stay on the same positional slot to accept more
      } else {
        out[cur] = coerce(ty, tok);
        posIdx++;
      }
    }
  }
  return out;
}


const WRAPPER_NAMES = new Set(["ZodOptional", "ZodNullable", "ZodDefault", "ZodReadonly", "ZodCatch"]);

/** Peel the optional-like wrappers off a schema. Stops at the first concrete
 * type — important because zod 4's ZodArray.unwrap() returns the element
 * type, which would walk too far. */
function unwrap(ty: z.ZodTypeAny): z.ZodTypeAny {
  let cur: any = ty;
  while (cur && WRAPPER_NAMES.has(cur.constructor?.name) && typeof cur.unwrap === "function") {
    try {
      cur = cur.unwrap();
    } catch {
      break;
    }
  }
  return cur;
}

function isBoolean(ty: z.ZodTypeAny): boolean {
  return unwrap(ty) instanceof z.ZodBoolean;
}

function isArray(ty: z.ZodTypeAny): boolean {
  return unwrap(ty) instanceof z.ZodArray;
}

function arrayInner(ty: z.ZodTypeAny): z.ZodTypeAny {
  const root = unwrap(ty) as any;
  // zod 3: root._def.type, zod 4: root.element / root.def.element
  return root.element ?? root._def?.type ?? root.def?.element ?? root;
}

function enumValues(ty: z.ZodTypeAny): string[] {
  const root = unwrap(ty) as any;
  // zod 3: _def.values is an array. zod 4: ZodEnum stores entries as a record.
  const v = root._def?.values ?? root.options ?? root.enum;
  if (Array.isArray(v)) return v;
  if (v && typeof v === "object") return Object.values(v).filter((x): x is string => typeof x === "string");
  const entries = root.def?.entries;
  if (entries && typeof entries === "object") return Object.values(entries).filter((x): x is string => typeof x === "string");
  return [];
}

function coerce(ty: z.ZodTypeAny, raw: string): unknown {
  const root = unwrap(ty);
  if (root instanceof z.ZodNumber) {
    const n = Number(raw);
    if (!Number.isFinite(n)) throw new Error(`expected number, got "${raw}"`);
    return n;
  }
  if (root instanceof z.ZodBoolean) {
    return raw === "true" || raw === "1";
  }
  if (root instanceof z.ZodEnum) {
    const values = enumValues(ty);
    if (values.length && !values.includes(raw)) {
      throw new Error(`expected one of ${values.join("|")}, got "${raw}"`);
    }
    return raw;
  }
  return raw;
}

// --- help ---

function rootHelp(): string {
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

function toolHelp(tool: ToolDef): string {
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

function fieldDesc(ty: z.ZodTypeAny): string {
  return (ty as any)._def?.description ?? (ty as any).description ?? "";
}

function typeHint(ty: z.ZodTypeAny): string {
  const root = unwrap(ty);
  if (root instanceof z.ZodArray) return `${typeHint(arrayInner(ty))}[,…]`;
  if (root instanceof z.ZodNumber) return "number";
  if (root instanceof z.ZodEnum) {
    const values = enumValues(ty);
    return values.length ? values.join("|") : "enum";
  }
  return "value";
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

main(process.argv.slice(2))
  .then((code) => process.exit(code))
  .catch((e) => {
    process.stderr.write(`tslsp fatal: ${e?.stack ?? e}\n`);
    process.exit(1);
  });
