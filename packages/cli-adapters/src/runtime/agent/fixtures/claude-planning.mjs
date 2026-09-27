#!/usr/bin/env node
import { readFileSync } from "node:fs"
process.stdin.resume()
const args = process.argv.slice(2)
const config = JSON.parse(readFileSync(args[args.indexOf("--mcp-config") + 1], "utf8")).mcpServers.jingler
if (config.timeout !== 86_400_000) throw new Error("Interactive relay timeout is missing")
const call = async (method, params = {}) => {
  const response = await fetch(config.url, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", Authorization: `Bearer ${process.env.JINGLER_TOOL_RELAY_TOKEN}` },
    body: JSON.stringify({ jsonrpc: "2.0", id: method, method, params })
  })
  const value = await response.json()
  if (value.error) throw new Error("Relay request failed")
  return value.result
}
const listed = await call("tools/list")
await call("tools/call", { name: "plannotator_update_plan", arguments: { filePath: "plan.md" } })
const output = await call("tools/call", { name: "plannotator_submit_plan", arguments: { filePath: "plan.md" } })
const prompt = args[args.indexOf("--system-prompt") + 1]
console.log(JSON.stringify({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: JSON.stringify({ names: listed.tools.map(tool => tool.name), output: output.content, inherited: prompt.includes("jingler.identity-and-safety") }) } } }))
console.log(JSON.stringify({ type: "result", is_error: false, usage: {} }))
