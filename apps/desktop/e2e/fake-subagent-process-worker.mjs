import { dirname } from "node:path"
import { createInterface } from "node:readline"
import { SessionManager } from "@earendil-works/pi-coding-agent"

const send = (value) => process.stdout.write(`${JSON.stringify(value)}\n`)
const lines = createInterface({ input: process.stdin })
let launch

lines.on("line", (line) => {
  const message = JSON.parse(line)
  if (message.type === "init") {
    launch = message.launch
    const extensions = launch?.extensionPaths ?? []
    const leaked = process.env.ANTHROPIC_API_KEY ||
      process.env.ANTHROPIC_AUTH_TOKEN ||
      process.env.ANTHROPIC_BASE_URL ||
      process.env.CLAUDE_CODE_USE_BEDROCK ||
      process.env.CLAUDE_CODE_USE_VERTEX ||
      process.env.CLAUDE_CODE_USE_FOUNDRY
    if (leaked || !extensions.some((path) => path.includes("claude-cli-provider"))) {
      send({ type: "fatal", error: "Claude child isolation was not installed" })
      return
    }
    send({ type: "ready", sessionId: "claude-child-e2e", modelId: "anthropic/claude-sonnet-5" })
    return
  }
  if (message.type === "prompt") {
    if (message.text?.includes("Detached native worker e2e")) {
      const sessionFile = launch?.storage?.sessionFile
      if (!sessionFile) {
        send({ type: "fatal", error: "Detached child requires file storage" })
        return
      }
      const manager = SessionManager.open(sessionFile, dirname(sessionFile), process.cwd())
      manager.appendMessage({ role: "user", content: message.text, timestamp: Date.now() })
      manager.appendMessage({
        role: "assistant",
        content: [{ type: "text", text: "Detached Claude child progress: waiting for stop." }],
        api: "anthropic-messages",
        provider: "anthropic",
        model: "claude-sonnet-5",
        usage: {
          input: 1,
          output: 8,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 9,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
        },
        stopReason: "toolUse",
        timestamp: Date.now()
      })
      send({
        type: "event",
        event: {
          type: "tool_execution_start",
          toolCallId: "detached-progress",
          toolName: "command_inspect",
          args: { program: "git", args: ["status", "--short"] }
        }
      })
    } else send({
      type: "event",
      event: {
        type: "message_end",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "Claude child completed the brokered design audit." }],
          api: "anthropic-messages",
          provider: "anthropic",
          model: "claude-sonnet-5",
          usage: {
            input: 1,
            output: 8,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 9,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
          },
          stopReason: "stop",
          timestamp: Date.now()
        }
      }
    })
  }
  if (message.id) send({ type: "response", id: message.id, success: true })
  if (message.type === "dispose") process.exit(0)
})
