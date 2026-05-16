#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerTools } from "./mcp.js";
import { LspPool } from "./workspace.js";

const VERBOSE = process.env.TSLSP_MCP_VERBOSE === "1";

async function main() {
  const log = VERBOSE ? (line: string) => process.stderr.write(line + "\n") : undefined;
  const pool = new LspPool(log);

  const server = new McpServer(
    { name: "tslsp-mcp", version: "0.1.0" },
    { capabilities: { tools: {} } },
  );
  registerTools(server, { pool, cwd: process.cwd() });

  const transport = new StdioServerTransport();
  await server.connect(transport);

  const shutdown = async () => {
    await pool.disposeAll();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((e) => {
  process.stderr.write(`tslsp-mcp fatal: ${e?.stack ?? e}\n`);
  process.exit(1);
});
