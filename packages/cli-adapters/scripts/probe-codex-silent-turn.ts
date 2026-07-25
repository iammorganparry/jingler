#!/usr/bin/env node

import { spawn } from "node:child_process"
import { redactCodexDiagnosticText } from "../src/codex-app-server-diagnostics.js"

const PROMPT =
  "Reply with exactly PONG. Do not call tools, inspect files, browse, or perform any other action."
const MAX_ATTEMPTS = 50
const MAX_TIMEOUT_MS = 10 * 60_000
const STDERR_LIMIT = 16_384
const REPLAY_QUIET_MS = 1_000

const usage = `Usage:
  pnpm --filter @starbase/cli-adapters probe:codex-silent -- [options]

Options:
  --attempts <1-${MAX_ATTEMPTS}>          Number of probe turns (default: 6)
  --timeout-ms <1000-${MAX_TIMEOUT_MS}>  Per-event inactivity deadline (default: 120000)
  --lifecycle <mode>          restart-resume | reuse | fresh (default: restart-resume)
  --model <name>              Codex model (default: gpt-5.6-sol)
  --effort <level>            Codex reasoning effort (default: medium)
  --cwd <path>                Read-only working directory (default: current directory)
  --bin <path>                Codex executable (default: codex)
  --bin-arg <value>           Argument before app-server; may be repeated
  --help                      Show this help

The probe creates its own thread, never accepts a production thread id, uses a
read-only sandbox, and emits redacted JSONL. It exits 2 if any turn stalls.`

const failArgument = (message) => {
  process.stderr.write(`${message}\n\n${usage}\n`)
  process.exit(64)
}

const integerArgument = (name, raw, minimum, maximum) => {
  const value = Number(raw)
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    failArgument(`${name} must be an integer from ${minimum} to ${maximum}`)
  }
  return value
}

const parseArguments = (argv) => {
  const options = {
    attempts: 6,
    timeoutMs: 120_000,
    lifecycle: "restart-resume",
    model: "gpt-5.6-sol",
    effort: "medium",
    cwd: process.cwd(),
    bin: "codex",
    binArgs: []
  }
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === "--") continue
    if (argument === "--help") {
      process.stdout.write(`${usage}\n`)
      process.exit(0)
    }
    const value = argv[index + 1]
    if (value === undefined || (argument !== "--bin-arg" && value.startsWith("--"))) {
      failArgument(`${argument} requires a value`)
    }
    index += 1
    switch (argument) {
      case "--attempts":
        options.attempts = integerArgument(argument, value, 1, MAX_ATTEMPTS)
        break
      case "--timeout-ms":
        options.timeoutMs = integerArgument(argument, value, 1_000, MAX_TIMEOUT_MS)
        break
      case "--lifecycle":
        if (!["restart-resume", "reuse", "fresh"].includes(value)) {
          failArgument("--lifecycle must be restart-resume, reuse, or fresh")
        }
        options.lifecycle = value
        break
      case "--model":
        options.model = value
        break
      case "--effort":
        options.effort = value
        break
      case "--cwd":
        options.cwd = value
        break
      case "--bin":
        options.bin = value
        break
      case "--bin-arg":
        options.binArgs.push(value)
        break
      default:
        failArgument(`unknown option: ${argument}`)
    }
  }
  return options
}

const isObject = (value) => typeof value === "object" && value !== null

const elapsedMs = (startedAt) => Number(process.hrtime.bigint() - startedAt) / 1_000_000

const boundedAppend = (current, addition, limit) => {
  const combined = current + addition
  return combined.length <= limit ? combined : combined.slice(combined.length - limit)
}

class RpcConnection {
  constructor(options) {
    this.child = spawn(options.bin, [...options.binArgs, "app-server"], {
      cwd: options.cwd,
      stdio: ["pipe", "pipe", "pipe"]
    })
    this.pending = new Map()
    this.messages = []
    this.waiters = []
    this.nextId = 1
    this.stdoutBuffer = ""
    this.stderrTail = ""
    this.closed = false
    this.failure = null
    this.exit = null

    this.child.stdout.on("data", (chunk) => this.onStdout(chunk))
    this.child.stdin.on("error", (error) => this.finish(error))
    this.child.stderr.on("data", (chunk) => {
      this.stderrTail = boundedAppend(this.stderrTail, chunk.toString(), STDERR_LIMIT)
    })
    this.child.on("error", (error) => this.finish(error))
    this.child.on("exit", (code, signal) => {
      this.exit = { code, signal }
      this.finish(null)
    })
  }

  onStdout(chunk) {
    this.stdoutBuffer += chunk.toString()
    for (;;) {
      const newline = this.stdoutBuffer.indexOf("\n")
      if (newline < 0) return
      const line = this.stdoutBuffer.slice(0, newline)
      this.stdoutBuffer = this.stdoutBuffer.slice(newline + 1)
      this.onLine(line)
    }
  }

  onLine(line) {
    if (line.trim().length === 0) return
    let message: unknown
    try {
      message = JSON.parse(line)
    } catch {
      return
    }
    if (isObject(message)) this.receive(message)
  }

  receive(message) {
    const responseId =
      typeof message.id === "number" || typeof message.id === "string" ? message.id : null
    if (message.method === undefined && responseId !== null) {
      const pending = this.pending.get(responseId)
      if (pending === undefined) return
      this.pending.delete(responseId)
      clearTimeout(pending.timeout)
      if (message.error !== undefined) {
        pending.reject(new Error(this.errorText(message.error)))
      } else {
        pending.resolve(message.result ?? null)
      }
      return
    }
    const waiter = this.waiters.shift()
    if (waiter === undefined) this.messages.push(message)
    else waiter(message)
  }

  errorText(error) {
    if (!isObject(error)) return String(error)
    return typeof error.message === "string" ? error.message : JSON.stringify(error)
  }

  finish(error) {
    if (this.closed) return
    this.closed = true
    this.failure = error
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout)
      pending.reject(error ?? new Error("Codex app-server closed"))
    }
    this.pending.clear()
    for (const waiter of this.waiters.splice(0)) waiter(null)
  }

  request(method, params, timeoutMs) {
    if (this.closed) {
      return Promise.reject(this.failure ?? new Error("Codex app-server is closed"))
    }
    const id = this.nextId
    this.nextId += 1
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        if (!this.pending.delete(id)) return
        reject(new Error(`${method} request timed out after ${timeoutMs}ms`))
      }, timeoutMs)
      this.pending.set(id, { resolve, reject, timeout })
      this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`)
    })
  }

  notify(method, params) {
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`)
  }

  respondError(id, message) {
    this.child.stdin.write(
      `${JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32000, message } })}\n`
    )
  }

  nextMessageWithin(timeoutMs) {
    const queued = this.messages.shift()
    if (queued !== undefined) return Promise.resolve(queued)
    if (this.closed) return Promise.resolve(null)
    return new Promise((resolve) => {
      let settled = false
      const waiter = (message) => {
        if (settled) return
        settled = true
        clearTimeout(timeout)
        resolve(message)
      }
      const timeout = setTimeout(() => {
        if (settled) return
        settled = true
        const index = this.waiters.indexOf(waiter)
        if (index >= 0) this.waiters.splice(index, 1)
        resolve(undefined)
      }, timeoutMs)
      this.waiters.push(waiter)
    })
  }

  async drainReplay() {
    for (;;) {
      // biome-ignore lint/performance/noAwaitInLoops: Protocol messages must be drained in arrival order.
      const message = await this.nextMessageWithin(REPLAY_QUIET_MS)
      if (message === undefined || message === null) return
      if (message.id !== undefined && typeof message.method === "string") {
        this.respondError(message.id, "Probe does not permit server-initiated actions")
      }
    }
  }

  async close() {
    if (!this.closed) {
      this.child.kill("SIGTERM")
      await new Promise((resolve) => {
        const timeout = setTimeout(() => {
          if (!this.closed) this.child.kill("SIGKILL")
          resolve()
        }, 2_000)
        this.child.once("exit", () => {
          clearTimeout(timeout)
          resolve()
        })
      })
    }
    this.finish(null)
  }
}

const requestTimed = async (connection, method, params, timeoutMs) => {
  const startedAt = process.hrtime.bigint()
  const result = await connection.request(method, params, timeoutMs)
  return { result, milliseconds: elapsedMs(startedAt) }
}

const threadIdFrom = (response) => {
  const id = response?.thread?.id
  if (typeof id !== "string" || id.length === 0) {
    throw new Error("Codex app-server returned no thread id")
  }
  return id
}

const turnIdFrom = (response) => {
  const id = response?.turn?.id
  if (typeof id !== "string" || id.length === 0) {
    throw new Error("Codex app-server returned no turn id")
  }
  return id
}

const completedTurn = (message, expectedTurnId) =>
  message?.method === "turn/completed" && message?.params?.turn?.id === expectedTurnId

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: The branches are the probe's explicit protocol state machine.
// biome-ignore lint/complexity/noExcessiveLinesPerFunction: Keeping one turn's state local prevents diagnostic fields drifting apart.
const executeTurn = async ({ connection, options, threadId, attempt, lifecycle }) => {
  const turnStartedAt = process.hrtime.bigint()
  const started = await requestTimed(
    connection,
    "turn/start",
    {
      threadId,
      input: [{ type: "text", text: PROMPT, text_elements: [] }],
      cwd: options.cwd,
      model: options.model,
      effort: options.effort
    },
    options.timeoutMs
  )
  const turnId = turnIdFrom(started.result)
  const methods = []
  let firstEventMs = null
  let contextTokens = null
  let outcome = "zero-event-stall"
  let error = null

  for (;;) {
    // biome-ignore lint/performance/noAwaitInLoops: Turn notifications must be observed sequentially.
    const message = await connection.nextMessageWithin(options.timeoutMs)
    if (message === undefined) {
      outcome = methods.length === 0 ? "zero-event-stall" : "post-event-stall"
      break
    }
    if (message === null) {
      outcome = methods.length === 0 ? "zero-event-close" : "post-event-close"
      error = connection.failure?.message ?? "Codex app-server closed"
      break
    }
    if (firstEventMs === null) firstEventMs = elapsedMs(turnStartedAt)
    const method = typeof message.method === "string" ? message.method : "<unknown>"
    methods.push(method)
    const reportedContextTokens = message.params?.tokenUsage?.last?.totalTokens
    if (Number.isFinite(reportedContextTokens)) contextTokens = reportedContextTokens

    if (message.id !== undefined && typeof message.method === "string") {
      connection.respondError(message.id, "Probe does not permit server-initiated actions")
      outcome = "server-action-requested"
      error = message.method
      break
    }
    if (completedTurn(message, turnId)) {
      const status = message.params?.turn?.status
      outcome = status === "completed" ? "completed" : `turn-${status ?? "unknown"}`
      break
    }
  }

  return {
    type: "sample",
    timestamp: new Date().toISOString(),
    attempt,
    lifecycle,
    model: options.model,
    effort: options.effort,
    requestMs: { turnStart: Math.round(started.milliseconds) },
    firstEventMs: firstEventMs === null ? null : Math.round(firstEventMs),
    completedMs: outcome === "completed" ? Math.round(elapsedMs(turnStartedAt)) : null,
    contextTokens,
    methods,
    stderrTail: redactCodexDiagnosticText(connection.stderrTail),
    processExit: connection.exit,
    outcome,
    error: error === null ? null : redactCodexDiagnosticText(error)
  }
}

const openConnection = async (options) => {
  const connection = new RpcConnection(options)
  const initialized = await requestTimed(
    connection,
    "initialize",
    {
      clientInfo: { name: "starbase-silent-turn-probe", version: "1" },
      capabilities: { experimentalApi: true }
    },
    options.timeoutMs
  )
  connection.notify("initialized", {})
  return { connection, initializeMs: Math.round(initialized.milliseconds) }
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: The top-level lifecycle matrix is intentionally visible in one orchestration function.
// biome-ignore lint/complexity/noExcessiveLinesPerFunction: Splitting this diagnostic orchestration would obscure resource ownership.
const main = async () => {
  const options = parseArguments(process.argv.slice(2))
  let connection = null
  let threadId = null
  let stalls = 0
  const latencies = []

  for (let attempt = 1; attempt <= options.attempts; attempt += 1) {
    const shouldRestart =
      connection === null || options.lifecycle === "restart-resume" || options.lifecycle === "fresh"
    if (shouldRestart) {
      // biome-ignore lint/performance/noAwaitInLoops: Attempts intentionally run sequentially to avoid introducing concurrency as a variable.
      await connection?.close()
      const opened = await openConnection(options)
      connection = opened.connection

      const useFreshThread = threadId === null || options.lifecycle === "fresh"
      const threadMethod = useFreshThread ? "thread/start" : "thread/resume"
      const threadParams = useFreshThread
        ? {
            cwd: options.cwd,
            model: options.model,
            sandbox: "read-only",
            approvalPolicy: "never",
            ephemeral: false
          }
        : {
            threadId,
            cwd: options.cwd,
            model: options.model,
            sandbox: "read-only",
            approvalPolicy: "never"
          }
      const thread = await requestTimed(connection, threadMethod, threadParams, options.timeoutMs)
      threadId = threadIdFrom(thread.result)
      await connection.drainReplay()
      connection.probeTimings = {
        initialize: opened.initializeMs,
        thread: Math.round(thread.milliseconds)
      }
    }

    const sample = await executeTurn({
      connection,
      options,
      threadId,
      attempt,
      lifecycle: options.lifecycle
    }).catch((cause) => ({
      type: "sample",
      timestamp: new Date().toISOString(),
      attempt,
      lifecycle: options.lifecycle,
      model: options.model,
      effort: options.effort,
      requestMs: {},
      firstEventMs: null,
      completedMs: null,
      contextTokens: null,
      methods: [],
      stderrTail: redactCodexDiagnosticText(connection.stderrTail),
      processExit: connection.exit,
      outcome: "probe-error",
      error: redactCodexDiagnosticText(cause instanceof Error ? cause.message : String(cause))
    }))
    sample.requestMs = { ...connection.probeTimings, ...sample.requestMs }
    process.stdout.write(`${JSON.stringify(sample)}\n`)
    if (sample.outcome !== "completed") stalls += 1
    if (sample.firstEventMs !== null) latencies.push(sample.firstEventMs)
    if (sample.outcome !== "completed" && options.lifecycle === "reuse") {
      await connection.close()
      connection = null
      threadId = null
    }
  }

  await connection?.close()
  const sorted = [...latencies].sort((left, right) => left - right)
  const percentile = (ratio) =>
    sorted.length === 0
      ? null
      : sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * ratio))]
  process.stdout.write(
    `${JSON.stringify({
      type: "summary",
      timestamp: new Date().toISOString(),
      lifecycle: options.lifecycle,
      attempts: options.attempts,
      completed: options.attempts - stalls,
      stalls,
      firstEventMs: {
        minimum: sorted[0] ?? null,
        p50: percentile(0.5),
        p95: percentile(0.95),
        maximum: sorted.at(-1) ?? null
      }
    })}\n`
  )
  if (stalls > 0) process.exitCode = 2
}

main().catch((cause) => {
  process.stderr.write(`${cause instanceof Error ? cause.stack : String(cause)}\n`)
  process.exitCode = 1
})
