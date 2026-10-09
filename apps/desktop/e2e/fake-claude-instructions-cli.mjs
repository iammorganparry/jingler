#!/usr/bin/env node
const args = process.argv.slice(2)
if (args[0] === "auth" && args[1] === "status") {
  console.log(JSON.stringify({ loggedIn: true, authMethod: "claude.ai", apiProvider: "firstParty", subscriptionType: "max" }))
  process.exit(0)
}
for await (const _ of process.stdin) { /* drain the request */ }
const prompt = args[args.indexOf("--system-prompt") + 1] ?? ""
const missing = ["USER_RULE_MARKER", "PROJECT_MANAGED_RULE_MARKER"].filter((marker) => !prompt.includes(marker))
const text = missing.length === 0
  ? "Claude received the user and project rules."
  : `Claude is missing instructions: ${missing.join(", ")}`
console.log(JSON.stringify({ type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } } }))
console.log(JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "done" }))
