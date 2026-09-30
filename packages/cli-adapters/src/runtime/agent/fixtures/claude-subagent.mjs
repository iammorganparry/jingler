#!/usr/bin/env node
import { readFileSync } from "node:fs"

if (process.argv.includes("--version")) {
  console.log("2.1.282")
  process.exit(0)
}
if (process.argv.includes("auth")) {
  console.log(JSON.stringify({ loggedIn: true, authMethod: "claude.ai", apiProvider: "firstParty", subscriptionType: "pro" }))
  process.exit(0)
}

let input = ""
for await (const chunk of process.stdin) input += chunk
const detached = input.includes("Launch the retained native workflow")
const parent = input.includes("Delegate this native Claude task") || detached
if (!parent) {
  console.log(JSON.stringify({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "PI child completed without a configured PI provider." } } }))
  console.log(JSON.stringify({ type: "result", is_error: false, usage: {} }))
  process.exit(0)
}

const path = process.argv[process.argv.indexOf("--mcp-config") + 1]
const { url, headers } = JSON.parse(readFileSync(path, "utf8")).mcpServers.jingler
headers.Authorization = headers.Authorization.replace(/\$\{([^}]+)\}/g, (_, key) => process.env[key])
const response = await fetch(url, {
  method: "POST",
  headers: { ...headers, "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
  body: JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: {
      name: "subagent",
      arguments: detached
        ? {
            async: true,
            agent: "worker",
            task: "Detached native worker e2e; remain active until stopped."
          }
        : { agent: "researcher", task: "Return the child completion sentence." }
    }
  })
})
const message = await response.json()
const envelope = JSON.parse(message.result?.content?.[0]?.text ?? "null")
if (detached) {
  if (envelope?.status !== "running" || typeof envelope?.runId !== "string") {
    throw new Error("Native Claude did not start the retained workflow")
  }
} else if (!/PI child completed|Claude child completed/u.test(String(envelope?.result))) {
  throw new Error("Native Claude did not receive the PI-backed child result")
}
console.log(JSON.stringify({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: detached ? "Native Claude parent settled after detached launch." : "Native Claude received the PI-backed child result." } } }))
console.log(JSON.stringify({ type: "result", is_error: false, usage: {} }))
