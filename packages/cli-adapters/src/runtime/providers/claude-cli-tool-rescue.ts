import type { RelayedToolCall } from "./claude-cli-sampling-relay.js"

/** Claude CLI names every relayed tool `mcp__<server>__<tool>`. */
const RELAY_TOOL_PREFIX = "mcp__jingler__"
const NO_SUCH_TOOL = "No such tool available"

const recordOf = (value: unknown): Record<string, unknown> | null =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null

const contentOf = (record: Record<string, unknown>): ReadonlyArray<Record<string, unknown>> => {
  const content = recordOf(record.message)?.content
  if (!Array.isArray(content)) return []
  return content.flatMap((part) => {
    const record = recordOf(part)
    return record === null ? [] : [record]
  })
}

const textOf = (content: unknown): string =>
  typeof content === "string"
    ? content
    : Array.isArray(content)
      ? content.map((part) => String(recordOf(part)?.text ?? "")).join("")
      : ""

export interface ToolRescueObservation {
  /** The call to hand pi, once the CLI has rejected a tool pi offered. */
  readonly call: RelayedToolCall | null
}

/**
 * Recover a tool call the Claude CLI refused as "No such tool available".
 *
 * The CLI occasionally starts a run without the relay's tools registered, and
 * then rejects a call to a tool pi DID offer — the call never reaches the
 * relay, the model concludes its shell is gone, and the turn stalls (seen with
 * command_execute, command_inspect and subagent while file reads kept
 * working). The CLI's own stream still carries the model's `tool_use` block, so
 * the call is recovered from there and handed to pi exactly as a relayed call
 * would be. Only tools pi offered are rescued; anything else stays rejected.
 */
interface PendingUse {
  readonly name: string
  readonly input: unknown
}

const bareName = (name: string): string =>
  name.startsWith(RELAY_TOOL_PREFIX) ? name.slice(RELAY_TOOL_PREFIX.length) : name

/** The first "No such tool available" result in a user record, by tool_use id. */
const rejectedToolUseId = (record: Record<string, unknown>): string | null => {
  for (const part of contentOf(record)) {
    if (part.type !== "tool_result" || part.is_error !== true) continue
    if (typeof part.tool_use_id !== "string") continue
    if (textOf(part.content).includes(NO_SUCH_TOOL)) return part.tool_use_id
  }
  return null
}

export const makeClaudeCliToolRescue = (
  offered: ReadonlySet<string>,
  warn: (message: string) => void = (message) => console.warn(message)
) => {
  const pending = new Map<string, PendingUse>()
  let registered: ReadonlyArray<string> | null = null

  const remember = (record: Record<string, unknown>): void => {
    for (const part of contentOf(record)) {
      if (part.type === "tool_use" && typeof part.id === "string" && typeof part.name === "string") {
        pending.set(part.id, { name: part.name, input: part.input })
      }
    }
  }

  const describeRegistration = (name: string): string =>
    registered === null
      ? "no init seen"
      : `${registered.length} registered, ${registered.includes(RELAY_TOOL_PREFIX + name) ? "including" : "without"} it`

  const rescue = (record: Record<string, unknown>): RelayedToolCall | null => {
    const id = rejectedToolUseId(record)
    const use = id === null ? undefined : pending.get(id)
    if (id === null || use === undefined) return null
    const name = bareName(use.name)
    if (!offered.has(name)) {
      warn(`[claude-cli] model called unknown tool ${use.name} (${describeRegistration(name)})`)
      return null
    }
    warn(`[claude-cli] rescued ${use.name}: the CLI rejected a tool pi offered (${describeRegistration(name)})`)
    return { id, name, arguments: recordOf(use.input) ?? {} }
  }

  return (value: unknown): ToolRescueObservation => {
    const record = recordOf(value)
    if (record?.type === "system" && record.subtype === "init" && Array.isArray(record.tools)) {
      registered = record.tools.filter((tool): tool is string => typeof tool === "string")
    } else if (record?.type === "assistant") {
      remember(record)
    } else if (record?.type === "user") {
      return { call: rescue(record) }
    }
    return { call: null }
  }
}
