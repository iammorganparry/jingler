#!/usr/bin/env node
// Fake `claude` for mcp-import-claudeai.spec.ts: answers `auth status`, `mcp list`
// and one streamed session that checks the imported connector through Jingler's relay.
import { readFileSync, writeFileSync } from "node:fs"

const args = process.argv.slice(2)
const mcpUrl = process.env.FAKE_CLAUDE_MCP_URL
if (args[0] === "--version") { console.log("2.1.286 (Claude Code)"); process.exit(0) }
if (args[0] === "auth" && args[1] === "status") {
  console.log(JSON.stringify({ loggedIn: true, authMethod: "claude.ai", apiProvider: "firstParty", subscriptionType: "max" }))
  process.exit(0)
}
if (args[0] === "mcp" && args[1] === "list") {
  console.log([
    "Checking MCP server health…",
    "",
    `claude.ai Linear: ${mcpUrl} - ! Needs authentication`,
    `claude.ai Supabase - GTM Grid: ${mcpUrl} - ✔ Connected`,
    `plugin:eng:notion: ${mcpUrl} (HTTP) - ! Needs authentication`,
    "plugin:eng:google calendar:  (HTTP) - - Not configured"
  ].join("\n"))
  process.exit(0)
}

writeFileSync(process.env.FAKE_CLAUDE_ARGS_FILE, JSON.stringify(args))
for await (const _ of process.stdin) { /* drain the stream-json prompt */ }
const { url, headers } = JSON.parse(readFileSync(args[args.indexOf("--mcp-config") + 1], "utf8")).mcpServers.jingler
headers.Authorization = headers.Authorization.replace(/\$\{([^}]+)\}/g, (_, key) => process.env[key])
const response = await fetch(url, {
  method: "POST",
  headers: { ...headers, "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
  body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "mcp_search", arguments: { query: "", server: "claude-ai-linear" } } })
})
const text = (await response.json()).result?.content?.[0]?.text ?? ""
const seen = text.includes("claude-ai-linear") && text.includes("lookup")
console.log(JSON.stringify({
  type: "stream_event",
  event: { type: "content_block_delta", delta: { type: "text_delta", text: seen ? "Claude saw the imported Linear connector." : `Claude missed the connector: ${text}` } }
}))
console.log(JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "done" }))
