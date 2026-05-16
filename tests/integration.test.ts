import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ChildProcess, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(here, "..");
const dist = resolve(projectRoot, "dist", "index.js");

let workspace: string;
let proc: ChildProcess;
let buf = Buffer.alloc(0);
const pending = new Map<number, { res: (v: any) => void; rej: (e: Error) => void }>();
let nextId = 1;

function send(msg: unknown): void {
  proc.stdin!.write(JSON.stringify(msg) + "\n");
}

function rpc<T = any>(method: string, params: unknown, ms = 30_000): Promise<T> {
  const id = nextId++;
  return new Promise<T>((res, rej) => {
    const t = setTimeout(() => {
      pending.delete(id);
      rej(new Error(`timeout: ${method}`));
    }, ms);
    pending.set(id, {
      res: (v) => { clearTimeout(t); res(v); },
      rej: (e) => { clearTimeout(t); rej(e); },
    });
    send({ jsonrpc: "2.0", id, method, params });
  });
}

async function callTool(name: string, args: Record<string, unknown>): Promise<string> {
  const r: any = await rpc("tools/call", { name, arguments: args });
  return (r.content as Array<{ text: string }>).map((c) => c.text).join("\n");
}

beforeAll(async () => {
  // Make sure the package is built before we try to launch it.
  if (!existsSync(dist)) {
    const build = spawnSync("pnpm", ["run", "build"], { cwd: projectRoot, stdio: "inherit" });
    if (build.status !== 0) throw new Error("pnpm run build failed");
  }

  // Build a fresh sample workspace so concurrent test runs / past failures
  // don't pollute state. We use a tmp dir, not the in-tree probe/sample/.
  workspace = mkdtempSync(resolve(tmpdir(), "tslsp-int-"));
  writeFileSync(
    resolve(workspace, "tsconfig.json"),
    JSON.stringify(
      {
        compilerOptions: {
          target: "es2022",
          module: "esnext",
          moduleResolution: "bundler",
          strict: true,
          noEmit: true,
        },
        include: ["src/**/*"],
      },
      null,
      2,
    ),
    "utf8",
  );
  spawnSync("mkdir", ["-p", resolve(workspace, "src")]);
  writeFileSync(
    resolve(workspace, "src", "math.ts"),
    [
      "export function add(a: number, b: number): number {",
      "  return a + b;",
      "}",
      "",
      "export function double(x: number): number {",
      "  return add(x, x);",
      "}",
      "",
    ].join("\n"),
    "utf8",
  );
  writeFileSync(
    resolve(workspace, "src", "index.ts"),
    [
      'import { add, double } from "./math";',
      "",
      "const result = add(1, 2);",
      "const doubled = double(result);",
      "console.log(doubled);",
      "",
    ].join("\n"),
    "utf8",
  );

  proc = spawn("node", [dist], { cwd: workspace, stdio: ["pipe", "pipe", "pipe"] });
  // Drain stderr so the child doesn't block on a full pipe.
  proc.stderr!.on("data", () => {});

  proc.stdout!.on("data", (chunk: Buffer) => {
    buf = Buffer.concat([buf, chunk]);
    while (true) {
      const nl = buf.indexOf(0x0a);
      if (nl === -1) return;
      const line = buf.slice(0, nl).toString("utf8").replace(/\r$/, "");
      buf = buf.slice(nl + 1);
      if (!line) continue;
      let msg: any;
      try { msg = JSON.parse(line); } catch { continue; }
      if (msg.id !== undefined && pending.has(msg.id)) {
        const p = pending.get(msg.id)!;
        pending.delete(msg.id);
        if (msg.error) p.rej(new Error(msg.error.message));
        else p.res(msg.result);
      }
    }
  });

  await rpc("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "vitest", version: "0" },
  });
  send({ jsonrpc: "2.0", method: "notifications/initialized" });
});

afterAll(async () => {
  if (proc && !proc.killed) {
    proc.kill("SIGTERM");
    await new Promise((r) => setTimeout(r, 50));
  }
});

describe("MCP integration", () => {
  it("exposes the expected tools", async () => {
    const list: any = await rpc("tools/list", {});
    const names = list.tools.map((t: { name: string }) => t.name).sort();
    expect(names).toEqual([
      "call_hierarchy",
      "code_action",
      "definition",
      "diagnostics",
      "find_symbol",
      "hover",
      "implementation",
      "outline",
      "references",
      "rename",
      "rename_file",
      "type_definition",
    ]);
  });

  it("find_symbol resolves a workspace symbol by name", async () => {
    const out = await callTool("find_symbol", { query: "add" });
    expect(out).toMatch(/src\/math\.ts:1.*function add/);
  });

  it("references finds all 4 sites for `add` across both files", async () => {
    const out = await callTool("references", { symbol: "add" });
    expect(out.match(/src\/math\.ts/g)?.length).toBe(2);
    expect(out.match(/src\/index\.ts/g)?.length).toBe(2);
  });

  it("references via { file, line, symbol } yields the same hits", async () => {
    const out = await callTool("references", {
      file: resolve(workspace, "src/math.ts"),
      line: 0,
      symbol: "add",
    });
    expect(out.match(/src\/(math|index)\.ts/g)?.length).toBe(4);
  });

  it("definition jumps to the declaration site", async () => {
    const out = await callTool("definition", {
      file: resolve(workspace, "src/index.ts"),
      line: 2,
      symbol: "add",
    });
    expect(out).toMatch(/src\/math\.ts:1.*function add/);
  });

  it("hover returns a trimmed signature", async () => {
    const out = await callTool("hover", { symbol: "double" });
    expect(out).toMatch(/function double\(x: number\): number/);
  });

  it("outline lists declarations", async () => {
    const out = await callTool("outline", { file: resolve(workspace, "src/math.ts") });
    expect(out).toMatch(/function add/);
    expect(out).toMatch(/function double/);
  });

  it("rename dry_run returns a preview without touching disk", async () => {
    const out = await callTool("rename", {
      symbol: "add",
      new_name: "sum",
      dry_run: true,
    });
    expect(out).toMatch(/preview.*4 sites in 2 files/);
    // confirm files are unchanged
    const after = await callTool("references", { symbol: "add" });
    expect(after.match(/src\/(math|index)\.ts/g)?.length).toBe(4);
  });

  it("rename apply changes 4 sites and references reflect the new name", async () => {
    const out = await callTool("rename", { symbol: "add", new_name: "sum" });
    expect(out).toMatch(/changed 4 sites in 2 files/);
    const after = await callTool("references", { symbol: "sum" });
    expect(after.match(/src\/(math|index)\.ts/g)?.length).toBe(4);
  });

  it("hover batch via `symbols` returns labeled sections in parallel", async () => {
    const out = await callTool("hover", { symbols: ["sum", "double"] });
    expect(out).toMatch(/=== sum ===/);
    expect(out).toMatch(/=== double ===/);
    expect(out).toMatch(/function sum/);
    expect(out).toMatch(/function double/);
  });

  it("outline accepts files array and labels each file", async () => {
    const out = await callTool("outline", {
      files: [resolve(workspace, "src/math.ts"), resolve(workspace, "src/index.ts")],
    });
    expect(out).toMatch(/=== .*math\.ts ===/);
    expect(out).toMatch(/=== .*index\.ts ===/);
    expect(out).toMatch(/function sum/);
  });

  it("rename_file dry_run reports the move and the imports it would rewrite", async () => {
    const out = await callTool("rename_file", {
      old_path: resolve(workspace, "src/math.ts"),
      new_path: resolve(workspace, "src/arithmetic.ts"),
      dry_run: true,
    });
    expect(out).toMatch(/preview/);
    expect(out).toMatch(/src\/math\.ts -> src\/arithmetic\.ts/);
  });

  it("rename_file applies the move and updates imports across the project", async () => {
    const out = await callTool("rename_file", {
      old_path: resolve(workspace, "src/math.ts"),
      new_path: resolve(workspace, "src/arithmetic.ts"),
    });
    expect(out).toMatch(/moved 1 path/);
    // After the move, `outline` on the new path should still find the symbols.
    const outline = await callTool("outline", { file: resolve(workspace, "src/arithmetic.ts") });
    expect(outline).toMatch(/function sum/);
  });
});
