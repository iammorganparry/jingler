import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { z } from "zod"

const server = new McpServer({ name: "jingler-test-stdio", version: "1.0.0" })

server.registerTool(
  "read_client_name",
  { description: "Return the MCP initialize client name." },
  async () => {
    const client = server.server.getClientVersion()
    return { content: [{ type: "text", text: `${client?.name ?? "missing"}:${client?.title ?? "missing"}` }] }
  }
)

server.registerTool(
  "read_fixture_env",
  {
    description: "Return the target-local fixture value.",
    inputSchema: { prefix: z.string() }
  },
  async ({ prefix }) => ({
    content: [{ type: "text", text: `${prefix}:${process.env.JINGLER_MCP_FIXTURE ?? "missing"}` }]
  })
)

await server.connect(new StdioServerTransport())
