#!/usr/bin/env node
// Enterprise seat: per-token billing. Emits NO rate_limit_event, but reports spend on the result.
const args = process.argv.slice(2)
if (args.includes("--version")) {
  console.log("2.1.300 (Claude Code)")
  process.exit(0)
}
if (args[0] === "auth" && args[1] === "status") {
  console.log(JSON.stringify({ loggedIn: true, authMethod: "claude.ai", apiProvider: "firstParty", subscriptionType: "enterprise" }))
  process.exit(0)
}
for await (const _ of process.stdin) { /* drain the request */ }
console.log(JSON.stringify({ type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Enterprise run complete." } } }))
console.log(JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "done", total_cost_usd: 1.25, usage: { input_tokens: 1000, output_tokens: 500 } }))
