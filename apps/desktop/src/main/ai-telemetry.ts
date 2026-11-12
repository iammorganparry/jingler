/**
 * PostHog AI observability for agent turns, sent from main.
 *
 * Each turn becomes one `$ai_trace`, one `$ai_generation` (model, prompt, reply,
 * context, cost) and one `$ai_span` per tool call. `$ai_session_id` is the chat,
 * so PostHog's Sessions tab groups a conversation. Content is sent in full
 * (clipped per field), which is why this is opt-in: `config.telemetryEnabled`
 * must be exactly `true`.
 */
import { randomUUID } from "node:crypto"
import { readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import type { StreamEvent } from "@jingler/core"
import { Effect, Stream } from "effect"

const MAX_FIELD = 4000
const clip = (text: string | null | undefined): string | null =>
  text == null ? null : text.length > MAX_FIELD ? `${text.slice(0, MAX_FIELD)}…[truncated]` : text

interface ToolRecord {
  readonly id: string
  readonly name: string
  readonly target: string | null
  readonly intent?: string
  readonly agentId?: string
  readonly startedAt: number
  endedAt?: number
  status?: string
  output?: string
  meta?: string | null
}

export interface Turn {
  readonly traceId: string
  readonly sessionId: string
  readonly chatId: string
  readonly prompt: string
  readonly startedAt: number
  model?: string
  reply: string
  readonly tools: Map<string, ToolRecord>
  context?: { readonly tokens: number; readonly window?: number; readonly breakdown?: unknown }
  done?: { readonly costUsd: number; readonly tokens: number }
  error?: string
  endedAt?: number
}

export const newTurn = (sessionId: string, chatId: string, prompt: string, now = Date.now()): Turn =>
  ({ traceId: randomUUID(), sessionId, chatId, prompt, startedAt: now, reply: "", tools: new Map() })

/** Fold one stream event into the turn. */
export function recordEvent(turn: Turn, event: StreamEvent, now = Date.now()): void {
  switch (event._tag) {
    case "Started":
      turn.model = event.model ?? turn.model
      return
    case "Assistant":
      // Sub-agent text has its own transcript; the reply is the main agent's.
      if (!event.agentId) turn.reply += event.text
      return
    case "ToolStart":
      turn.tools.set(event.id, { id: event.id, name: event.name, target: event.target, intent: event.intent, agentId: event.agentId, startedAt: now })
      return
    case "ToolEnd": {
      const tool = turn.tools.get(event.id)
      if (tool) Object.assign(tool, { endedAt: now, status: event.status, output: event.output, meta: event.meta })
      return
    }
    case "Usage":
      turn.context = { tokens: event.tokens, window: event.window, breakdown: event.breakdown }
      return
    case "Done":
      turn.done = { costUsd: event.costUsd, tokens: event.tokens }
      turn.endedAt = now
      return
    case "Failed":
      turn.error = event.message
      turn.endedAt = now
      return
    default:
      return
  }
}

export interface PostHogEvent {
  readonly event: string
  readonly timestamp: string
  readonly properties: Record<string, unknown>
}

const seconds = (from: number, to: number | undefined): number | null => (to === undefined ? null : (to - from) / 1000)

/** The PostHog events for a finished (or abandoned) turn. Pure. */
export function turnEvents(turn: Turn, distinctId: string, now = Date.now()): PostHogEvent[] {
  const endedAt = turn.endedAt ?? now
  const error = turn.error ?? (turn.endedAt === undefined ? "Turn ended without a completion event" : null)
  const base = {
    distinct_id: distinctId,
    $process_person_profile: false,
    $ai_trace_id: turn.traceId,
    $ai_session_id: turn.chatId,
    jingler_session_id: turn.sessionId,
    app_version: __APP_VERSION__
  }
  const at = (ms: number) => new Date(ms).toISOString()
  const trace: PostHogEvent = {
    event: "$ai_trace",
    timestamp: at(turn.startedAt),
    properties: {
      ...base,
      $ai_span_name: "turn",
      $ai_input_state: clip(turn.prompt),
      $ai_output_state: clip(turn.reply),
      $ai_latency: seconds(turn.startedAt, endedAt),
      $ai_is_error: error !== null,
      $ai_error: error
    }
  }
  const generation: PostHogEvent = {
    event: "$ai_generation",
    timestamp: at(turn.startedAt),
    properties: {
      ...base,
      $ai_span_id: `${turn.traceId}:generation`,
      $ai_parent_id: turn.traceId,
      $ai_model: turn.model ?? "unknown",
      $ai_input: [{ role: "user", content: clip(turn.prompt) }],
      $ai_output_choices: [{ role: "assistant", content: clip(turn.reply) }],
      $ai_input_tokens: turn.context?.tokens ?? turn.done?.tokens ?? null,
      $ai_total_cost_usd: turn.done?.costUsd ?? null,
      $ai_latency: seconds(turn.startedAt, endedAt),
      $ai_is_error: error !== null,
      $ai_error: error,
      context_tokens: turn.context?.tokens ?? null,
      context_window: turn.context?.window ?? null,
      context_breakdown: turn.context?.breakdown ?? null,
      tool_call_count: turn.tools.size
    }
  }
  const spans = [...turn.tools.values()].map((tool): PostHogEvent => ({
    event: "$ai_span",
    timestamp: at(tool.startedAt),
    properties: {
      ...base,
      $ai_span_id: tool.id,
      $ai_span_name: tool.name,
      $ai_parent_id: turn.traceId,
      $ai_input_state: { target: clip(tool.target), intent: tool.intent ?? null },
      $ai_output_state: { output: clip(tool.output), meta: clip(tool.meta) },
      $ai_latency: seconds(tool.startedAt, tool.endedAt),
      $ai_is_error: tool.status === "error",
      tool_status: tool.status ?? "unfinished",
      agent_id: tool.agentId ?? null
    }
  }))
  return [trace, generation, ...spans]
}

export interface SendDeps {
  readonly key: string | undefined
  readonly host: string
  readonly enabled: () => Promise<boolean>
  readonly distinctId: () => Promise<string>
  readonly fetch: typeof fetch
}

/** Send a turn if a key is built in and the operator opted in. Never throws. */
export async function sendTurn(turn: Turn, deps: SendDeps): Promise<void> {
  try {
    if (!deps.key || !(await deps.enabled())) return
    const batch = turnEvents(turn, await deps.distinctId())
    await deps.fetch(new URL("/batch/", deps.host), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ api_key: deps.key, batch })
    })
  } catch (cause) {
    console.error("AI telemetry send failed", cause)
  }
}

// Lazy: app-paths calls electron's app.getPath at import, which would break every
// module (and test) that imports this file without a full electron stub.
const root = async () => (await import("./app-paths.js")).jinglerRoot

const liveDeps: SendDeps = {
  key: import.meta.env.VITE_POSTHOG_KEY,
  host: import.meta.env.VITE_POSTHOG_HOST || "https://us.i.posthog.com",
  enabled: async () => {
    try {
      return JSON.parse(await readFile(join(await root(), "config.json"), "utf8")).telemetryEnabled === true
    } catch {
      return false
    }
  },
  // A random per-install id: nothing identifying, but stable so traces group by user.
  distinctId: async () => {
    const file = join(await root(), "telemetry-id")
    const existing = await readFile(file, "utf8").catch(() => "")
    if (existing.trim()) return existing.trim()
    const id = randomUUID()
    await writeFile(file, id, { mode: 0o600 })
    return id
  },
  fetch
}

/**
 * Tap a turn's event stream and send it to PostHog when the stream ends.
 * ponytail: only sees turns while someone consumes the stream (chat UI, routines);
 * move into AgentRunner if detached turns need tracing.
 */
export const observeTurn = <E, R>(
  sessionId: string,
  chatId: string,
  prompt: string,
  stream: Stream.Stream<StreamEvent, E, R>,
  deps: SendDeps = liveDeps
): Stream.Stream<StreamEvent, E, R> =>
  Stream.suspend(() => {
    const turn = newTurn(sessionId, chatId, prompt)
    return stream.pipe(
      Stream.tap((event) => Effect.sync(() => recordEvent(turn, event))),
      Stream.ensuring(Effect.sync(() => void sendTurn(turn, deps)))
    )
  })
