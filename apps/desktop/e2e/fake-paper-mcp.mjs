import { Server } from "@modelcontextprotocol/sdk/server/index.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js"

const server = new Server(
  { name: "paper-e2e", version: "1.0.0" },
  { capabilities: { tools: {} } }
)

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [{
    name: "inspect_design",
    description: "Inspect the current Paper app design.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false }
  }]
}))
server.setRequestHandler(CallToolRequestSchema, async () => ({
  content: [{
    type: "text",
    text: process.env.PAPER_TOKEN === "paper-e2e-secret"
      ? "Paper canvas inspected through Jingler MCP."
      : "Paper server did not receive its credential."
  }]
}))

await server.connect(new StdioServerTransport())
