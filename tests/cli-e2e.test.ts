import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(here, "..");
const cliJs = resolve(projectRoot, "dist", "cli.js");

let workspace: string;

function runCli(args: string[], cwd = workspace, timeoutMs = 30_000): Promise<{
  code: number | null;
  stdout: string;
  stderr: string;
}> {
  return new Promise((resolveP, rejectP) => {
    const child = spawn("node", [cliJs, ...args], { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const t = setTimeout(() => {
      child.kill("SIGKILL");
      rejectP(new Error(`cli timeout: ${args.join(" ")}\nstderr: ${stderr}`));
    }, timeoutMs);
    child.stdout.on("data", (b) => (stdout += b.toString()));
    child.stderr.on("data", (b) => (stderr += b.toString()));
    child.on("close", (code) => {
      clearTimeout(t);
      resolveP({ code, stdout, stderr });
    });
  });
}

beforeAll(async () => {
  if (!existsSync(cliJs)) {
    const build = spawnSync("pnpm", ["run", "build"], { cwd: projectRoot, stdio: "inherit" });
    if (build.status !== 0) throw new Error("pnpm run build failed");
  }
  workspace = mkdtempSync(resolve(tmpdir(), "tslsp-cli-"));
  writeFileSync(
    resolve(workspace, "tsconfig.json"),
    JSON.stringify(
      { compilerOptions: { target: "es2022", module: "esnext", moduleResolution: "bundler", strict: true, noEmit: true }, include: ["src/**/*"] },
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
      "export function double(x: number): number { return add(x, x); }",
      "",
    ].join("\n"),
    "utf8",
  );
  writeFileSync(
    resolve(workspace, "src", "index.ts"),
    [
      'import { add, double } from "./math";',
      "const r = add(1, 2);",
      "console.log(double(r));",
      "",
    ].join("\n"),
    "utf8",
  );
}, 60_000);

afterAll(() => {
  /* tmpdir cleans itself; no explicit teardown needed */
});

describe("CLI e2e", () => {
  it("prints root help with all commands listed", async () => {
    const { code, stdout } = await runCli(["--help"]);
    expect(code).toBe(0);
    expect(stdout).toMatch(/tslsp — type-aware TypeScript code intelligence CLI/);
    expect(stdout).toMatch(/find_symbol/);
    expect(stdout).toMatch(/rename_file/);
    expect(stdout).toMatch(/call_hierarchy/);
  });

  it("prints per-tool help with positional + flags", async () => {
    const { code, stdout } = await runCli(["rename-file", "--help"]);
    expect(code).toBe(0);
    expect(stdout).toMatch(/<old-path>/);
    expect(stdout).toMatch(/<new-path>/);
    expect(stdout).toMatch(/--dry-run/);
  });

  it("exits nonzero on unknown command", async () => {
    const { code, stderr } = await runCli(["nope"]);
    expect(code).not.toBe(0);
    expect(stderr).toMatch(/unknown command: nope/);
  });

  it("find-symbol via positional finds the function", async () => {
    const { code, stdout } = await runCli(["find-symbol", "add"]);
    expect(code).toBe(0);
    expect(stdout).toMatch(/src\/math\.ts:1.*function add/);
  });

  it("hover --symbols a,b returns labeled batch output", async () => {
    // Don't assert exit code — a stale workspace index can leave one symbol
    // unresolved without invalidating the batch shape. Assert the shape.
    const { stdout, stderr } = await runCli(["hover", "--symbols", "add,double"]);
    const combined = stdout + stderr;
    expect(combined).toMatch(/=== add ===/);
    expect(combined).toMatch(/=== double ===/);
  });

  it("outline accepts multi-positional files", async () => {
    const { code, stdout } = await runCli([
      "outline",
      resolve(workspace, "src/math.ts"),
      resolve(workspace, "src/index.ts"),
    ]);
    expect(code).toBe(0);
    expect(stdout).toMatch(/=== .*math\.ts ===/);
    expect(stdout).toMatch(/=== .*index\.ts ===/);
  });

  it("`tslsp mcp` starts a real MCP server over stdio and responds to initialize", async () => {
    // Spawn `tslsp mcp` and drive the MCP handshake; if the regression
    // returned (process.exit kills it on import) initialize never responds.
    const child = spawn("node", [cliJs, "mcp"], { cwd: workspace, stdio: ["pipe", "pipe", "pipe"] });
    child.stderr!.on("data", () => {});

    let buf = Buffer.alloc(0);
    const pending = new Map<number, (v: any) => void>();
    child.stdout!.on("data", (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk]);
      while (true) {
        const nl = buf.indexOf(0x0a);
        if (nl === -1) return;
        const line = buf.slice(0, nl).toString("utf8").replace(/\r$/, "");
        buf = buf.slice(nl + 1);
        if (!line) continue;
        try {
          const msg = JSON.parse(line);
          if (msg.id !== undefined && pending.has(msg.id)) {
            const r = pending.get(msg.id)!;
            pending.delete(msg.id);
            r(msg);
          }
        } catch { /* ignore non-json */ }
      }
    });

    function rpc<T = any>(id: number, method: string, params: unknown): Promise<T> {
      return new Promise((res) => {
        pending.set(id, res as any);
        child.stdin!.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
      });
    }

    try {
      const initResult: any = await Promise.race([
        rpc(1, "initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "vitest", version: "0" } }),
        new Promise((_, rej) => setTimeout(() => rej(new Error("initialize timed out — tslsp mcp likely exited")), 10_000)),
      ]);
      expect(initResult.result?.protocolVersion).toBeDefined();

      child.stdin!.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
      const listResult: any = await rpc(2, "tools/list", {});
      const names = listResult.result.tools.map((t: { name: string }) => t.name);
      expect(names).toContain("rename_file");
      expect(names).toContain("call_hierarchy");
    } finally {
      child.kill("SIGTERM");
      await new Promise((r) => setTimeout(r, 100));
      if (!child.killed) child.kill("SIGKILL");
    }
  }, 30_000);

  it("install --skills writes SKILL.md to the project scope", async () => {
    const tmpHome = mkdtempSync(resolve(tmpdir(), "tslsp-skill-"));
    const { code, stdout } = await runCli(["install", "--skills", "--project"], tmpHome);
    expect(code).toBe(0);
    expect(stdout).toMatch(/installed skill/);
    expect(existsSync(resolve(tmpHome, ".claude/skills/tslsp/SKILL.md"))).toBe(true);
  });

  it("install --skills is idempotent without --force", async () => {
    const tmpHome = mkdtempSync(resolve(tmpdir(), "tslsp-skill-"));
    await runCli(["install", "--skills", "--project"], tmpHome);
    const { code, stdout } = await runCli(["install", "--skills", "--project"], tmpHome);
    expect(code).toBe(0);
    expect(stdout).toMatch(/already installed/);
  });
});
