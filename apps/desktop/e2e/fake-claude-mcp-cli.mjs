#!/usr/bin/env node
import { readFile } from "node:fs/promises"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"

const args = process.argv.slice(2)
if (args[0] === "auth" && args[1] === "status") {
  console.log(JSON.stringify({
    loggedIn: true,
    authMethod: "claude.ai",
    apiProvider: "firstParty",
    subscriptionType: "max"
  }))
  process.exit(0)
}

const valueAfter = (name) => args[args.indexOf(name) + 1]
const fail = (message) => {
  console.log(JSON.stringify({ type: "result", subtype: "error", is_error: true, result: message }))
  process.exit(0)
}
const prompt = valueAfter("--system-prompt")
if (!prompt?.includes("call mcp_search for that service before taking other action")) {
  fail("Claude did not receive the named MCP policy")
}
if (process.env.PAPER_TOKEN) fail("Paper credentials leaked into Claude")

let input = ""
for await (const chunk of process.stdin) input += chunk
const request = JSON.parse(input)
const transcript = request.message.content
  .filter(({ type }) => type === "text")
  .map(({ text }) => text)
  .join("\n")
const config = JSON.parse(await readFile(valueAfter("--mcp-config"), "utf8"))
const attachment = config.mcpServers.jingler
const transport = new StreamableHTTPClientTransport(new URL(attachment.url), {
  requestInit: { headers: attachment.headers }
})
const client = new Client({ name: "claude-mcp-e2e", version: "1.0.0" })
process.on("SIGINT", () => process.exit(0))
await client.connect(transport)
const toolNames = (await client.listTools()).tools.map(({ name }) => name)
if (!toolNames.includes("mcp_search") || !toolNames.includes("mcp_call")) {
  fail("Claude did not inherit Jingler MCP tools")
}

if (transcript.includes('name="mcp_call"')) {
  if (!transcript.includes("Paper canvas inspected through Jingler MCP")) {
    fail("Claude did not receive the Paper MCP result")
  }
  console.log(JSON.stringify({
    type: "stream_event",
    event: {
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: "Claude used the inherited Paper MCP through Jingler." }
    }
  }))
  console.log(JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "done" }))
  await client.close()
  process.exit(0)
}

await client.callTool(transcript.includes('name="mcp_search"')
  ? { name: "mcp_call", arguments: { server: "paper", tool: "inspect_design", arguments: {} } }
  : { name: "mcp_search", arguments: { query: "inspect_design", server: "paper" } })
