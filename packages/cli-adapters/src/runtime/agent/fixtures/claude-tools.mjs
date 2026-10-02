#!/usr/bin/env node
import { readFileSync } from "node:fs"

if (process.argv.includes("--version")) {
  console.log("2.1.282")
} else if (process.argv.includes("auth")) {
  console.log(JSON.stringify({ loggedIn: true, authMethod: "claude.ai", apiProvider: "firstParty" }))
} else {
  process.stdin.resume()
  const path = process.argv[process.argv.indexOf("--mcp-config") + 1]
  const { url, headers } = JSON.parse(readFileSync(path, "utf8")).mcpServers.jingler
  headers.Authorization = headers.Authorization.replace(/\$\{([^}]+)\}/g, (_, key) => process.env[key])
  const call = async (id, name, args) => {
    const response = await fetch(url, {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } })
    })
    const message = await response.json()
    if (message.result?.isError || !message.result?.content) throw new Error("Missing tool result")
    return JSON.parse(message.result.content[0].text)
  }
  const first = await call(1, "workspace_read_file", { path: "README.md" })
  const second = await call(2, "workspace_read_file", { path: "README.md" })
  if (!first.text.includes("e2e repo") || second.text !== first.text) throw new Error("Expected real workspace results")
  console.log(JSON.stringify({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "Claude completed two workspace tool rounds." } } }))
  console.log(JSON.stringify({ type: "assistant", parent_tool_use_id: null, message: { id: "last-request", content: [], usage: { input_tokens: 5700, cache_read_input_tokens: 100000, output_tokens: 200 } } }))
  console.log(JSON.stringify({ type: "result", is_error: false, usage: { input_tokens: 300000, output_tokens: 600 } }))
}
