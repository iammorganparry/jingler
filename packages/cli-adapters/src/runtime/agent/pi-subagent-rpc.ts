import { randomUUID } from "node:crypto"
import type { EventBus } from "@earendil-works/pi-coding-agent"

const REQUEST_EVENT = "subagents:rpc:v1:request"
const REPLY_EVENT_PREFIX = "subagents:rpc:v1:reply:"
const PROTOCOL_VERSION = 1
const DEFAULT_REPLY_TIMEOUT_MS = 10_000

export interface PiSubagentAsyncSpawnRequest {
  readonly agent?: string
  readonly task?: string
  readonly workflowScript?: string
  readonly cwd: string
  readonly context?: "fresh" | "fork"
  readonly thinking?: string
  readonly timeoutMs?: number
}

export interface PiSubagentAsyncSpawnResult {
  readonly runId: string
  readonly asyncDir: string
  readonly text: string
}

export type PiSubagentAsyncDelegate = (
  request: PiSubagentAsyncSpawnRequest,
  signal: AbortSignal
) => Promise<PiSubagentAsyncSpawnResult>

const record = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null

const requiredString = (value: unknown, field: string): string => {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`Malformed pi-subagents RPC reply: ${field} is missing`)
  }
  return value
}

const spawnResult = (reply: unknown, requestId: string): PiSubagentAsyncSpawnResult => {
  const envelope = record(reply)
  if (envelope?.version !== PROTOCOL_VERSION || envelope.requestId !== requestId) {
    throw new Error("Malformed pi-subagents RPC reply envelope")
  }
  if (envelope.success !== true) {
    const error = record(envelope.error)
    throw new Error(requiredString(error?.message, "error.message"))
  }
  const data = record(envelope.data)
  const details = record(data?.details)
  return {
    runId: requiredString(details?.asyncId, "details.asyncId"),
    asyncDir: requiredString(details?.asyncDir, "details.asyncDir"),
    text: typeof data?.text === "string" ? data.text : ""
  }
}

export const makePiSubagentAsyncDelegate = (
  events: EventBus,
  replyTimeoutMs = DEFAULT_REPLY_TIMEOUT_MS
): PiSubagentAsyncDelegate => async (request, signal) => {
  if (signal.aborted) throw signal.reason ?? new Error("Subagent RPC cancelled")
  const requestId = randomUUID()
  return new Promise<PiSubagentAsyncSpawnResult>((resolve, reject) => {
    let settled = false
    const finish = (result: () => void) => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      signal.removeEventListener("abort", cancel)
      unsubscribe()
      result()
    }
    const cancel = () => finish(() => reject(signal.reason ?? new Error("Subagent RPC cancelled")))
    const unsubscribe = events.on(`${REPLY_EVENT_PREFIX}${requestId}`, (reply) =>
      finish(() => {
        try {
          resolve(spawnResult(reply, requestId))
        } catch (cause) {
          reject(cause)
        }
      })
    )
    const timeout = setTimeout(() =>
      finish(() => reject(new Error("pi-subagents RPC spawn timed out"))),
    replyTimeoutMs)
    timeout.unref?.()
    signal.addEventListener("abort", cancel, { once: true })
    events.emit(REQUEST_EVENT, {
      version: PROTOCOL_VERSION,
      requestId,
      method: "spawn",
      params: { ...request, async: true },
      source: { extension: "jingler" }
    })
  })
}
