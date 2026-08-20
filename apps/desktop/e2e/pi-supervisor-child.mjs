import { randomUUID } from "node:crypto"
import { mkdir, readFile, rename, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { SessionManager } from "@earendil-works/pi-coding-agent"

const required = (name) => {
  const value = process.env[name]?.trim()
  if (!value) throw new Error(`${name} is required by the supervisor e2e child`)
  return value
}

const args = process.argv.slice(2)
const valueAfter = (flag) => {
  const index = args.indexOf(flag)
  return index === -1 ? undefined : args[index + 1]
}
const sessionFile = valueAfter("--session")
if (!sessionFile) throw new Error("The supervisor e2e child requires --session")
const taskArg = args.findLast((arg) => arg.startsWith("Task: "))
const task = taskArg?.slice("Task: ".length) ?? "Review the checkout flow"
const channelDir = required("PI_SUBAGENT_SUPERVISOR_CHANNEL_DIR")
const runId = required("PI_SUBAGENT_RUN_ID")
const agent = required("PI_SUBAGENT_CHILD_AGENT")
const childIndex = Number(required("PI_SUBAGENT_CHILD_INDEX"))
const orchestratorSessionId = required("PI_SUBAGENT_ORCHESTRATOR_SESSION_ID")
const orchestratorTarget = process.env.PI_SUBAGENT_ORCHESTRATOR_TARGET?.trim()
const requestId = `e2e-supervisor-${randomUUID()}`
const toolCallId = "e2e-contact-supervisor"
const now = Date.now()
const usage = {
  input: 10,
  output: 5,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 15,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
}
const manager = SessionManager.open(sessionFile, dirname(sessionFile), process.cwd())
manager.appendMessage({ role: "user", content: task, timestamp: now })
const questionMessage = {
  role: "assistant",
  content: [
    { type: "text", text: "I need the supervisor to choose the review depth." },
    {
      type: "toolCall",
      id: toolCallId,
      name: "contact_supervisor",
      arguments: {
        reason: "need_decision",
        message: "Should I include accessibility behavior in this review?"
      }
    }
  ],
  api: "jingler-e2e-api",
  provider: "e2e-pi",
  model: "eval-model",
  usage,
  stopReason: "toolUse",
  timestamp: now + 1
}
manager.appendMessage(questionMessage)
process.stdout.write(`${JSON.stringify({ type: "message_end", message: questionMessage })}\n`)
process.stdout.write(`${JSON.stringify({
  type: "tool_execution_start",
  toolCallId,
  toolName: "contact_supervisor",
  args: {
    reason: "need_decision",
    message: "Should I include accessibility behavior in this review?"
  }
})}\n`)

// Keep the filesystem request deliberately later than the tool-start event.
// Main must become interactive from proactive detach, not from watcher fallback.
await new Promise((resolve) => setTimeout(resolve, 8_000))
const requestsDir = join(channelDir, "requests")
const repliesDir = join(channelDir, "replies")
await Promise.all([
  mkdir(requestsDir, { recursive: true, mode: 0o700 }),
  mkdir(repliesDir, { recursive: true, mode: 0o700 })
])
const request = {
  type: "subagent.supervisor.request",
  id: requestId,
  createdAt: Date.now(),
  expiresAt: Date.now() + 30_000,
  reason: "need_decision",
  message: "Should I include accessibility behavior in this review?",
  expectsReply: true,
  ...(orchestratorTarget ? { orchestratorTarget } : {}),
  orchestratorSessionId,
  runId,
  agent,
  childIndex
}
const requestPath = join(requestsDir, `${requestId}.json`)
const temporary = `${requestPath}.tmp`
await writeFile(temporary, JSON.stringify(request), { mode: 0o600 })
await rename(temporary, requestPath)

const replyPath = join(repliesDir, `${requestId}.json`)
let reply
const deadline = Date.now() + 30_000
while (Date.now() < deadline) {
  try {
    // biome-ignore lint/performance/noAwaitInLoops: the reply file appears asynchronously.
    reply = JSON.parse(await readFile(replyPath, "utf8"))
    break
  } catch (error) {
    if (error?.code !== "ENOENT") throw error
  }
  await new Promise((resolve) => setTimeout(resolve, 25))
}
if (!reply || typeof reply.message !== "string") {
  throw new Error("Timed out waiting for the e2e supervisor reply")
}

const toolResult = {
  role: "toolResult",
  toolCallId,
  toolName: "contact_supervisor",
  content: [{ type: "text", text: `Reply from supervisor: ${reply.message}` }],
  isError: false,
  timestamp: Date.now()
}
manager.appendMessage(toolResult)
process.stdout.write(`${JSON.stringify({
  type: "tool_execution_end",
  toolCallId,
  toolName: "contact_supervisor",
  result: { content: toolResult.content, details: { requestId } },
  isError: false
})}\n`)
process.stdout.write(`${JSON.stringify({ type: "tool_result_end", message: toolResult })}\n`)
const finalMessage = {
  role: "assistant",
  content: [{ type: "text", text: `Review completed after supervisor reply: ${reply.message}` }],
  api: "jingler-e2e-api",
  provider: "e2e-pi",
  model: "eval-model",
  usage,
  stopReason: "stop",
  timestamp: Date.now() + 1
}
manager.appendMessage(finalMessage)
process.stdout.write(`${JSON.stringify({ type: "message_end", message: finalMessage })}\n`)
