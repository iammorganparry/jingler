import { randomUUID } from "node:crypto"
import { mkdir, readFile, rename, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { createInterface } from "node:readline"
import { SessionManager } from "@earendil-works/pi-coding-agent"

const send = (value) => process.stdout.write(`${JSON.stringify(value)}\n`)
const usage = {
  input: 10,
  output: 5,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 15,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
}
let launch

const run = async (task) => {
  const runtime = launch.runtime
  const sessionFile = launch.storage?.sessionFile
  if (!sessionFile) throw new Error("The supervisor e2e child requires file storage")
  const channelDir = runtime.supervisorChannelDir
  const runId = runtime.runId
  const agent = runtime.agent
  const childIndex = runtime.childIndex
  const orchestratorSessionId = runtime.orchestratorSessionId
  if (!channelDir || !runId || !agent || childIndex === undefined || !orchestratorSessionId) {
    throw new Error("The supervisor e2e child requires supervisor metadata")
  }
  const manager = SessionManager.open(sessionFile, dirname(sessionFile), process.cwd())
  const now = Date.now()
  const toolCallId = "e2e-contact-supervisor"
  const requestId = `e2e-supervisor-${randomUUID()}`
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
  send({ type: "event", event: { type: "message_end", message: questionMessage } })
  send({
    type: "event",
    event: {
      type: "tool_execution_start",
      toolCallId,
      toolName: "contact_supervisor",
      args: {
        reason: "need_decision",
        message: "Should I include accessibility behavior in this review?"
      }
    }
  })

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
    ...(runtime.orchestratorTarget ? { orchestratorTarget: runtime.orchestratorTarget } : {}),
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
  send({
    type: "event",
    event: {
      type: "tool_execution_end",
      toolCallId,
      toolName: "contact_supervisor",
      result: { content: toolResult.content, details: { requestId } },
      isError: false
    }
  })
  send({ type: "event", event: { type: "tool_result_end", message: toolResult } })
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
  send({ type: "event", event: { type: "message_end", message: finalMessage } })
  send({ type: "event", event: { type: "agent_settled" } })
}

createInterface({ input: process.stdin }).on("line", (line) => {
  void (async () => {
    const message = JSON.parse(line)
    if (message.type === "init") {
      launch = message.launch
      send({
        type: "ready",
        sessionFile: launch.storage?.sessionFile,
        sessionId: "e2e-supervisor-child",
        modelId: "e2e-pi/eval-model"
      })
      return
    }
    if (message.type === "prompt") await run(message.text ?? "Review the checkout flow")
    if (message.id) send({ type: "response", id: message.id, success: true })
    if (message.type === "dispose") process.exit(0)
  })().catch((error) => {
    send({ type: "fatal", error: error instanceof Error ? error.message : String(error) })
  })
})
