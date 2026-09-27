import type { StreamEvent } from "@jingler/core"
import type { ThreadItem } from "./generated/v2/ThreadItem.js"
import type { ThreadTokenUsage } from "./generated/v2/ThreadTokenUsage.js"
import type { CodexMessage } from "./client.js"

type ToolItem = Extract<ThreadItem, { type: "commandExecution" | "fileChange" | "mcpToolCall" }>
const toolStart = (item: ToolItem): StreamEvent => ({
  _tag: "ToolStart",
  id: item.id,
  name:
    item.type === "commandExecution"
      ? "Bash"
      : item.type === "fileChange"
        ? "Edit"
        : `${item.server}/${item.tool}`,
  target:
    item.type === "commandExecution"
      ? item.command
      : item.type === "fileChange"
        ? item.changes.map((change) => change.path).join(", ")
        : null
})
const toolEnd = (item: ToolItem): StreamEvent => {
  const patch =
    item.type === "fileChange" ? item.changes.map((change) => change.diff).join("\n") : null
  return {
    _tag: "ToolEnd",
    id: item.id,
    status: item.status === "completed" ? "success" : "error",
    meta: item.type === "commandExecution" ? `exit ${item.exitCode}` : null,
    diff:
      patch === null
        ? null
        : {
            added: patch
              .split("\n")
              .filter((line) => line.startsWith("+") && !line.startsWith("+++")).length,
            removed: patch
              .split("\n")
              .filter((line) => line.startsWith("-") && !line.startsWith("---")).length
          },
    preview: patch?.slice(0, 16_000) ?? null,
    ...(item.type === "commandExecution"
      ? { output: (item.aggregatedOutput ?? "").slice(-16_000) }
      : {})
  }
}

/** State belongs to one process/thread/turn and is discarded on cleanup. */
export class CodexEvents {
  private readonly started = new Set<string>()
  private readonly completed = new Set<string>()
  private readonly items = new Set<string>()
  private remember(id: string): void {
    if (id.length > 256 || (!this.items.has(id) && this.items.size >= 4096))
      throw new Error("Codex turn item bound exceeded")
    this.items.add(id)
  }
  private readonly streamed = new Set<string>()
  private readonly outputs = new Map<string, string>()
  tokens = 0
  private baseline: number | undefined
  map({ method, params: p }: CodexMessage): ReadonlyArray<StreamEvent> {
    if (p.itemId !== undefined) this.remember(String(p.itemId))
    if (p.itemId !== undefined && this.completed.has(String(p.itemId))) return []
    switch (method) {
      case "item/agentMessage/delta":
        if (typeof p.delta !== "string") return []
        this.streamed.add(String(p.itemId))
        return [{ _tag: "Assistant", text: p.delta }]
      case "item/reasoning/summaryTextDelta":
      case "item/reasoning/textDelta":
        return typeof p.delta === "string"
          ? [{ _tag: "Thinking", text: p.delta, seconds: null, done: false }]
          : []
      case "thread/tokenUsage/updated":
        return this.usage(p.tokenUsage as ThreadTokenUsage)
      case "item/commandExecution/outputDelta":
        return this.output(p)
      case "item/started":
        return this.item(p.item as ThreadItem, false)
      case "item/completed":
        return this.item(p.item as ThreadItem, true)
      default:
        return []
    }
  }
  private usage(usage: ThreadTokenUsage): ReadonlyArray<StreamEvent> {
    this.baseline ??= usage.total.totalTokens - usage.last.totalTokens
    this.tokens = Math.max(0, usage.total.totalTokens - this.baseline)
    return [
      {
        _tag: "Usage",
        tokens: usage.last.totalTokens,
        ...(usage.modelContextWindow == null ? {} : { window: usage.modelContextWindow })
      }
    ]
  }
  private output(p: Record<string, unknown>): ReadonlyArray<StreamEvent> {
    if (typeof p.delta !== "string") return []
    const id = String(p.itemId)
    if (!this.outputs.has(id) && this.outputs.size >= 128)
      throw new Error("Codex active output bound exceeded")
    const output = `${this.outputs.get(id) ?? ""}${p.delta}`.slice(-16_000)
    this.outputs.set(id, output)
    return [{ _tag: "ToolDelta", id, output }]
  }
  private agentMessage(item: Extract<ThreadItem, { type: "agentMessage" }>, done: boolean): ReadonlyArray<StreamEvent> {
    return done && !this.streamed.has(item.id) ? [{ _tag: "Assistant", text: item.text }] : []
  }
  private item(item: ThreadItem, done: boolean): ReadonlyArray<StreamEvent> {
    if (item.type === "mcpToolCall" && item.server === "jingler") return []
    this.remember(item.id)
    if (this.completed.has(item.id)) return []
    if (!done && this.started.has(item.id)) return []
    if (done) this.completed.add(item.id)
    else this.started.add(item.id)
    if (item.type === "agentMessage") return this.agentMessage(item, done)
    if (item.type === "reasoning")
      return done ? [{ _tag: "Thinking", text: "", seconds: null, done: true }] : []
    if (
      item.type !== "commandExecution" &&
      item.type !== "fileChange" &&
      item.type !== "mcpToolCall"
    )
      return []
    if (done) this.outputs.delete(item.id)
    return [done ? toolEnd(item) : toolStart(item)]
  }
}
