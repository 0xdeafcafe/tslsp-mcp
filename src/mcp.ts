import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { TOOLS, ToolContext } from "./tools.js";
import { LspPool } from "./workspace.js";

export function registerTools(server: McpServer, ctx: ToolContext): void {
  for (const tool of TOOLS) {
    server.registerTool(
      tool.name,
      {
        title: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema,
      },
      async (input: any) => {
        const out = await tool.handler(input, ctx);
        return {
          content: [{ type: "text" as const, text: out.text }],
          ...(out.isError ? { isError: true } : {}),
        };
      },
    );
  }
}

/** Boot the MCP server over stdio. Resolves only on SIGINT/SIGTERM (or when
 * the transport closes) so callers can await without the process exiting
 * prematurely. */
export async function start(): Promise<void> {
  const verbose = process.env.TSLSP_MCP_VERBOSE === "1" || process.env.TSLSP_VERBOSE === "1";
  const log = verbose ? (line: string) => process.stderr.write(line + "\n") : undefined;
  const pool = new LspPool(log);

  const server = new McpServer(
    { name: "tslsp-mcp", version: "0.1.0" },
    { capabilities: { tools: {} } },
  );
  registerTools(server, { pool, cwd: process.cwd() });

  const transport = new StdioServerTransport();
  await server.connect(transport);

  await new Promise<void>((resolve) => {
    const shutdown = async () => {
      await pool.disposeAll();
      resolve();
    };
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
  });
}
