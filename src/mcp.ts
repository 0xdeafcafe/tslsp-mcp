import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { TOOLS, ToolContext } from "./tools.js";

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
