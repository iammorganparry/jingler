#!/usr/bin/env node
// Answers only what the endpoint probe asks: version, auth, and the model list.
if (process.argv.includes("--version")) {
  console.log("2.1.286")
} else if (process.argv.includes("auth")) {
  console.log(JSON.stringify({ loggedIn: true, authMethod: "claude.ai", apiProvider: "firstParty" }))
} else {
  let input = ""
  process.stdin.setEncoding("utf8")
  process.stdin.on("data", (chunk) => {
    input += chunk
    const line = input.split("\n").find((l) => l.includes("\"initialize\""))
    if (line === undefined) return
    const { request_id } = JSON.parse(line)
    console.log(JSON.stringify({
      type: "control_response",
      response: { subtype: "success", request_id, response: { models: [
        { value: "default", displayName: "Default (recommended)" },
        { value: "opus", displayName: "Opus 5.5" },
        { value: "sonnet", displayName: "Sonnet 5.5" },
        { value: "claude-fable-5-1", displayName: "Fable 5.1" }
      ] } }
    }))
    process.exit(0)
  })
}
