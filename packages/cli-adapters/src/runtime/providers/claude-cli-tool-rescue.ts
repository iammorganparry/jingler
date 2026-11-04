import { randomUUID } from "node:crypto"
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

/** Text of a tool_result `content`: a string or an array of text blocks. */
export const textOf = (content: unknown): string =>
  typeof content === "string"
    ? content
    : Array.isArray(content)
      ? content.map((part) => String(recordOf(part)?.text ?? "")).join("")
      : ""

/** The text of every tool_result in a stream-json `user` record. */
export const toolResultTexts = (record: unknown): ReadonlyArray<string> => {
  const parsed = recordOf(record)
  if (parsed === null) return []
  return contentOf(parsed).flatMap((part) => part.type === "tool_result" ? [textOf(part.content)] : [])
}

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

/** How older transcripts replayed tool calls; models copy it into reply text. */
const TEXT_CALL_MARKER = "<jingler-tool-call"
const TEXT_CALL = /^<jingler-tool-call\b[^>]*?\bname="([^"]+)"[^>]*>([\s\S]*?)<\/jingler-tool-call>/u

/** Length of the longest tail of `text` that could still grow into the marker. */
const markerTail = (text: string): number => {
  for (let n = Math.min(TEXT_CALL_MARKER.length - 1, text.length); n > 0; n--) {
    if (TEXT_CALL_MARKER.startsWith(text.slice(-n))) return n
  }
  return 0
}

const parseTextToolCall = (text: string, offered: ReadonlySet<string>): RelayedToolCall | null => {
  const match = TEXT_CALL.exec(text)
  if (match === null) return null
  const name = bareName(match[1]!)
  if (!offered.has(name)) return null
  let input: unknown
  try {
    input = JSON.parse(match[2]!)
  } catch {
    return null
  }
  const args = recordOf(input)
  return args === null ? null : { id: `text-${randomUUID()}`, name, arguments: args }
}

/**
 * Recover a tool call the model wrote as reply text (`<jingler-tool-call
 * name="…">{json}</jingler-tool-call>`) instead of calling the tool. Text from
 * the marker on is held back so the leak never reaches the chat; at the end it
 * becomes a real call for an offered tool, or is released unchanged.
 */
export const makeTextToolCallGuard = (
  offered: ReadonlySet<string>,
  warn: (message: string) => void = (message) => console.warn(message)
) => {
  let held = ""
  let leaked = false
  return {
    /** Feed a text delta; returns the part that is safe to show now. */
    push: (delta: string): string => {
      held += delta
      if (leaked) return ""
      const at = held.indexOf(TEXT_CALL_MARKER)
      const cut = at >= 0 ? at : held.length - markerTail(held)
      leaked = at >= 0
      const safe = held.slice(0, cut)
      held = held.slice(cut)
      return safe
    },
    /** Held text to release, or the call it spelled out. */
    finish: (): { readonly text: string; readonly call: RelayedToolCall | null } => {
      const text = held
      held = ""
      const call = leaked ? parseTextToolCall(text, offered) : null
      if (call === null) return { text, call }
      warn(`[claude-cli] rescued ${call.name}: the model wrote the tool call as text`)
      return { text: "", call }
    }
  }
}
