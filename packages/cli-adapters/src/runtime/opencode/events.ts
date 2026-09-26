import type { Event, Part, AssistantMessage, GlobalEvent } from "@opencode-ai/sdk/v2/client"
import type { StreamEvent } from "@jingler/core"

/** v1 sync envelopes coexist with legacy events in the 1.18.14 global stream. */
export const normalizeOpenCodeEvent = (payload: GlobalEvent["payload"]): Event | undefined => {
  if (payload.type !== "sync") return "properties" in payload ? payload as Event : undefined
  const sync = payload.syncEvent
  if (sync.type === "message.updated.1") return { id: payload.id, type: "message.updated", properties: sync.data }
  if (sync.type === "message.part.updated.1") return { id: payload.id, type: "message.part.updated", properties: sync.data }
  return undefined
}

export const eventSessionId = (event: Event): string | undefined => {
  if (event.type === "message.updated") return event.properties.info.sessionID
  if (event.type === "message.part.updated") return event.properties.part.sessionID
  return "sessionID" in event.properties && typeof event.properties.sessionID === "string" ? event.properties.sessionID : undefined
}

/** Per-turn state. Only messages parented by this turn's user message are admitted. */
export class OpenCodeEvents {
  private readonly messages = new Set<string>()
  private readonly parts = new Map<string, { type: string; text: string; done: boolean }>()
  private readonly usage = new Map<string, { tokens: number; cost: number }>()
  get hasResponse() { return this.messages.size > 0 }
  tokens = 0
  cost = 0
  constructor(readonly sessionID: string, readonly parentID: string) {}
  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: exhaustive vendor event normalization keeps per-turn correlation explicit.
  map(event: Event): StreamEvent[] {
    if (eventSessionId(event) !== this.sessionID) return []
    switch (event.type) {
      case "message.updated": {
        const message = event.properties.info
        if (message.role !== "assistant" || message.sessionID !== this.sessionID || message.parentID !== this.parentID) return []
        if (this.messages.size >= 4096 && !this.messages.has(message.id)) throw new Error("OpenCode message bound exceeded")
        this.messages.add(message.id)
        if (message.error) throw new Error("OpenCode assistant failed")
        return this.updateUsage(message)
      }
      case "message.part.updated": {
        const part = event.properties.part
        if (part.sessionID !== this.sessionID || !this.messages.has(part.messageID)) return []
        return this.part(part)
      }
      case "message.part.delta": {
        const p = event.properties
        if (!this.messages.has(p.messageID) || p.field !== "text") return []
        const part = this.parts.get(p.partID)
        if (!part || part.done || !["text", "reasoning"].includes(part.type)) return []
        part.text += p.delta
        if (part.text.length > 1_048_576) throw new Error("OpenCode text bound exceeded")
        return [part.type === "text" ? { _tag: "Assistant", text: p.delta } : { _tag: "Thinking", text: p.delta, seconds: null, done: false }]
      }
      default: return []
    }
  }
  private updateUsage(message: AssistantMessage): StreamEvent[] {
    const t = message.tokens
    const values = [t.input, t.output, t.reasoning, t.cache.read, t.cache.write]
    if (values.some(value => !Number.isFinite(value) || value < 0)) throw new Error("Invalid OpenCode usage")
    const tokens = values.reduce((sum, value) => sum + value, 0)
    if (!Number.isFinite(tokens) || tokens < 0 || !Number.isFinite(message.cost) || message.cost < 0) throw new Error("Invalid OpenCode usage")
    this.usage.set(message.id, { tokens, cost: message.cost })
    this.tokens = [...this.usage.values()].reduce((sum, value) => sum + value.tokens, 0)
    this.cost = [...this.usage.values()].reduce((sum, value) => sum + value.cost, 0)
    return [{ _tag: "Usage", tokens }]
  }
  private textPart(part: Extract<Part, { type: "text" | "reasoning" }>, state: { text: string; done: boolean }): StreamEvent[] {
    if (part.text.length > 1_048_576) throw new Error("OpenCode text bound exceeded")
    if (!part.text.startsWith(state.text)) throw new Error("OpenCode text changed non-monotonically")
    const delta = part.text.slice(state.text.length)
    state.text = part.text
    state.done = part.time?.end !== undefined
    if (!delta && !state.done) return []
    return [part.type === "text" ? { _tag: "Assistant", text: delta } : { _tag: "Thinking", text: delta, seconds: null, done: state.done }]
  }
  private toolPart(part: Extract<Part, { type: "tool" }>, state: { done: boolean }): StreamEvent[] {
    if (part.state.status !== "completed" && part.state.status !== "error") return []
    state.done = true
    const output = part.state.status === "completed" ? part.state.output : part.state.error
    const patch = part.state.metadata?.diff
    const preview = typeof patch === "string" ? patch.slice(0, 16_000) : null
    const lines = preview?.split("\n") ?? []
    return [{ _tag: "ToolEnd", id: part.callID, status: part.state.status === "completed" ? "success" : "error", meta: null, preview,
      diff: preview === null ? null : { added: lines.filter((line) => line.startsWith("+") && !line.startsWith("+++")).length, removed: lines.filter((line) => line.startsWith("-") && !line.startsWith("---")).length }, output: output.slice(-16_000) }]
  }
  private part(part: Part): StreamEvent[] {
    let state = this.parts.get(part.id)
    const events: StreamEvent[] = []
    if (!state) {
      if (this.parts.size >= 4096) throw new Error("OpenCode part bound exceeded")
      state = { type: part.type, text: "", done: false }
      this.parts.set(part.id, state)
      if (part.type === "tool") events.push({ _tag: "ToolStart", id: part.callID, name: part.tool, target: JSON.stringify(part.state.input).slice(0, 2000) })
    }
    if (state.done) return events
    if (part.type === "text" || part.type === "reasoning") events.push(...this.textPart(part, state))
    if (part.type === "tool") events.push(...this.toolPart(part, state))
    return events
  }
}
