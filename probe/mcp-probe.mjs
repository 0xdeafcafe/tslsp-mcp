// End-to-end verification probe: spawns the MCP server, exercises each tool
// against probe/sample/, prints results.
import { spawn } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const dist = resolve(__dirname, "../dist/index.js");
const sample = resolve(__dirname, "sample");
const mathFile = resolve(sample, "src/math.ts");

const proc = spawn("node", [dist], {
  cwd: sample,
  stdio: ["pipe", "pipe", "pipe"],
  env: { ...process.env, TSLSP_MCP_VERBOSE: "1" },
});

proc.stderr.on("data", (d) => process.stderr.write(`[mcp stderr] ${d}`));

let buf = Buffer.alloc(0);
const pending = new Map();
let nextId = 1;

function send(msg) {
  proc.stdin.write(JSON.stringify(msg) + "\n");
}

function rpc(method, params, timeoutMs = 30000) {
  const id = nextId++;
  return new Promise((res, rej) => {
    const t = setTimeout(() => {
      pending.delete(id);
      rej(new Error(`timeout: ${method}`));
    }, timeoutMs);
    pending.set(id, {
      res: (v) => { clearTimeout(t); res(v); },
      rej: (e) => { clearTimeout(t); rej(e); },
    });
    send({ jsonrpc: "2.0", id, method, params });
  });
}

proc.stdout.on("data", (chunk) => {
  buf = Buffer.concat([buf, chunk]);
  while (true) {
    const nl = buf.indexOf(0x0a);
    if (nl === -1) return;
    const line = buf.slice(0, nl).toString("utf8").replace(/\r$/, "");
    buf = buf.slice(nl + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    if (msg.id !== undefined && pending.has(msg.id)) {
      const { res, rej } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) rej(new Error(msg.error.message));
      else res(msg.result);
    }
  }
});

async function call(name, args) {
  const out = await rpc("tools/call", { name, arguments: args });
  return out.content?.map((c) => c.text).join("\n") ?? JSON.stringify(out);
}

function header(s) {
  console.log("\n=== " + s + " ===");
}

(async () => {
  await rpc("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "probe", version: "0" },
  });
  send({ jsonrpc: "2.0", method: "notifications/initialized" });

  const list = await rpc("tools/list", {});
  header("tools/list");
  console.log(list.tools.map((t) => `${t.name}: ${t.description.split("\n")[0]}`).join("\n"));

  header("find_symbol add");
  console.log(await call("find_symbol", { query: "add" }));

  header("references via { symbol: 'add' }");
  console.log(await call("references", { symbol: "add" }));

  header("references via { file, line, symbol }");
  console.log(await call("references", { file: mathFile, line: 0, symbol: "add" }));

  header("definition via { file, line, character }");
  console.log(await call("definition", { file: mathFile, line: 5, character: 9 }));

  header("hover via { symbol: 'double' }");
  console.log(await call("hover", { symbol: "double" }));

  header("outline math.ts");
  console.log(await call("outline", { file: mathFile }));

  header("rename dry_run add -> sum");
  console.log(await call("rename", { symbol: "add", new_name: "sum", dry_run: true }));

  header("rename APPLY add -> sum");
  console.log(await call("rename", { symbol: "add", new_name: "sum" }));

  header("references after rename, symbol: 'sum'");
  console.log(await call("references", { symbol: "sum" }));

  header("rename back sum -> add (cleanup)");
  console.log(await call("rename", { symbol: "sum", new_name: "add" }));

  header("diagnostics for math.ts");
  console.log(await call("diagnostics", { file: mathFile }));

  proc.kill("SIGINT");
  setTimeout(() => process.exit(0), 200);
})().catch((e) => {
  console.error("probe failed:", e);
  proc.kill();
  process.exit(1);
});
