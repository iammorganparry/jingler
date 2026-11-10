import { appendFileSync } from "node:fs"
import { randomUUID } from "node:crypto"
import { Server } from "@modelcontextprotocol/sdk/server/index.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js"

// Records each call to argv[2] with a token the model can't guess, so a test can prove the tool really ran.
const [, , logFile] = process.argv
const server = new Server({ name: "echo-e2e", version: "1.0.0" }, { capabilities: { tools: {} } })

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [{
    name: "echo_nonce",
    description: "Echo a nonce back with a server token.",
    inputSchema: { type: "object", properties: { nonce: { type: "string" } }, required: ["nonce"], additionalProperties: false }
  }]
}))
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const nonce = String(request.params.arguments?.nonce ?? "")
  const token = `ECHO-${randomUUID().slice(0, 8)}`
  appendFileSync(logFile, `${JSON.stringify({ nonce, token })}\n`)
  return { content: [{ type: "text", text: `Echo token: ${token}` }] }
})

await server.connect(new StdioServerTransport())
