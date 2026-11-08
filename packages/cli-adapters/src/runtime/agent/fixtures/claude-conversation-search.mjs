#!/usr/bin/env node
import { readFileSync } from "node:fs"

if (process.argv.includes("--version")) {
  console.log("2.1.282")
} else if (process.argv.includes("auth")) {
  console.log(JSON.stringify({ loggedIn: true, authMethod: "claude.ai", apiProvider: "firstParty" }))
} else {
  process.stdin.resume()
  const configPath = process.argv[process.argv.indexOf("--mcp-config") + 1]
  const { url, headers } = JSON.parse(readFileSync(configPath, "utf8")).mcpServers.jingler
  headers.Authorization = headers.Authorization.replace(/\$\{([^}]+)\}/g, (_, key) => process.env[key])
  const call = async (id, name, args) => {
    const response = await fetch(url, {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } })
    })
    const message = await response.json()
    if (message.result?.isError || !message.result?.content) throw new Error("Missing history tool result")
    return JSON.parse(message.result.content[0].text)
  }
  const query = "quartz capybara"
  const result = await call(1, "conversation_search", { query })
  const hit = result.hits.find((entry) => entry.chatId === "closed-chat")
  if (!hit || result.hits.some((entry) => entry.sessionId !== "current" && entry.sessionId !== "archive")) throw new Error("Expected scoped project history results")
  const { sessionId, chatId, messageId, messageIndex, before } = hit
  const excerpt = await call(2, "conversation_read", { query, sessionId, chatId, messageId, messageIndex, before })
  const answer = excerpt.messages.find((message) => message.text.includes("Reset the shared pool before reconnecting."))
  if (!answer) throw new Error("Missing neighboring conversation context")
  console.log(JSON.stringify({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: `From saved chat ${hit.chatId}: ${answer.text}` } } }))
  console.log(JSON.stringify({ type: "result", is_error: false, usage: { input_tokens: 1000, output_tokens: 40 } }))
}
