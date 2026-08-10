import { homedir } from "node:os"
import { join } from "node:path"
import type { Message, StreamEvent } from "@jingler/core"
import { applyStreamEvent, assistantMessage, userMessage } from "@jingler/core"
import { Either, Schema } from "effect"

/**
 * Rebuild a Jingler transcript from the Claude harness's own JSONL log.
 *
 * Jingler's `~/jingler/transcripts/<sessionId>.json` was once written with a
 * truncating overwrite, so killing the app mid-write (a dev restart) could leave
 * it 0 bytes — the session still resumed, because `resumeId` points at the
 * harness's own log, but Jingler's rendered history was gone. That log is a
 * complete second copy, so the history is recoverable.
 *
 * Fidelity comes from reusing the live code path rather than re-deriving it:
 * every line is replayed through `streamEventsFor` (the same SDK → StreamEvent
 * mapping the adapter uses) and folded with `applyStreamEvent` (the same fold
 * `AgentRunner` persists with), so tool targets, edit previews and output caps
 * match a live run without duplicating any of that logic.
 */

const TextBlock = Schema.Struct({ type: Schema.Literal("text"), text: Schema.String })
const ThinkingBlock = Schema.Struct({
  type: Schema.Literal("thinking"),
  thinking: Schema.String,
  signature: Schema.optional(Schema.String)
})
const ToolUseBlock = Schema.Struct({
  type: Schema.Literal("tool_use"),
  id: Schema.String,
  name: Schema.String,
  input: Schema.Record({ key: Schema.String, value: Schema.Unknown })
})
const ToolResultBlock = Schema.Struct({
  type: Schema.Literal("tool_result"),
  tool_use_id: Schema.String,
  content: Schema.String,
  is_error: Schema.optional(Schema.Boolean)
})
const TranscriptBlock = Schema.Union(TextBlock, ThinkingBlock, ToolUseBlock, ToolResultBlock)
type Block = Schema.Schema.Type<typeof TranscriptBlock>

const TranscriptLine = Schema.Struct({
  type: Schema.String,
  timestamp: Schema.optional(Schema.String),
  message: Schema.optional(Schema.Struct({
    role: Schema.optional(Schema.String),
    content: Schema.Union(Schema.String, Schema.Array(TranscriptBlock))
  }))
})
type TranscriptLine = Schema.Schema.Type<typeof TranscriptLine>

type ToolMemo = { readonly name: string; readonly input: Readonly<Record<string, unknown>> }

const blocksOf = (line: TranscriptLine): ReadonlyArray<Block> => {
  const content = line.message?.content
  if (typeof content === "string") return content.length > 0 ? [{ type: "text", text: content }] : []
  return content ?? []
}

/** A user line is a real PROMPT (a turn boundary) only if it carries text, not just tool results. */
const promptTextOf = (line: TranscriptLine): string | null => {
  const text = blocksOf(line)
    .filter((b) => b.type === "text")
    .map((b) => String(b.text ?? ""))
    .join("\n")
    .trim()
  return text.length > 0 ? text : null
}

const toolTarget = (memo: ToolMemo): string => {
  const value = memo.name === "Bash"
    ? memo.input.command
    : memo.input.file_path ?? memo.input.path
  return typeof value === "string" ? value : memo.name
}

const eventsFor = (
  line: TranscriptLine,
  tools: Map<string, ToolMemo>
): ReadonlyArray<StreamEvent> => {
  const events: StreamEvent[] = []
  for (const block of blocksOf(line)) {
    if (block.type === "thinking") {
      if (block.thinking.length > 0) {
        events.push({ _tag: "Thinking", text: block.thinking, seconds: null, done: true })
      }
      continue
    }
    if (block.type === "tool_use") {
      const memo = { name: block.name, input: block.input }
      tools.set(block.id, memo)
      events.push({
        _tag: "ToolStart",
        id: block.id,
        name: block.name,
        target: toolTarget(memo)
      })
      continue
    }
    if (block.type === "tool_result") {
      events.push({
        _tag: "ToolEnd",
        id: block.tool_use_id,
        status: block.is_error === true ? "error" : "success",
        meta: null,
        diff: null,
        preview: null,
        output: block.content
      })
    }
  }
  return events
}

/** Where Claude keeps a session's log: the cwd with every "/" replaced by "-". */
export const harnessLogPath = (worktreePath: string, resumeId: string): string =>
  join(homedir(), ".claude", "projects", worktreePath.replace(/\//g, "-"), `${resumeId}.jsonl`)

/**
 * Replay a harness log into the `Message[]` a session's transcript file holds.
 *
 * `jsonl` is the raw file contents. Unparseable lines are skipped rather than
 * fatal: the harness may still hold the file open, so a half-flushed final line
 * is expected and everything before it is still good.
 */
export const rebuildTranscript = (sessionId: string, jsonl: string): Message[] => {
  const lines = jsonl
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .flatMap((l) => {
      try {
        const decoded = Schema.decodeUnknownEither(TranscriptLine)(JSON.parse(l))
        return Either.isRight(decoded) ? [decoded.right] : []
      } catch {
        return []
      }
    })

  const out: Message[] = []
  // `AgentRunner` numbers ids `u_<sid>_<n>` / `a_<sid>_<n>` off ONE counter and,
  // on restart, re-seeds it from the max trailing number in the transcript. Match
  // that exactly, or the next real run re-emits ids colliding with these and the
  // virtualized list stacks rows keyed by them.
  let counter = 0
  const tools = new Map<string, ToolMemo>()
  let current: Message | null = null

  const closeAssistant = () => {
    if (current && current.parts.length > 0) out.push({ ...current, streaming: false })
    current = null
  }
  const fold = (events: readonly StreamEvent[], createdAt: string) => {
    for (const event of events) {
      // Bookkeeping events carry no content; folding them would be a no-op at
      // best and (Done/Failed) would append spurious parts.
      if (event._tag === "Usage" || event._tag === "Done" || event._tag === "Failed") continue
      if (!current) current = assistantMessage(`a_${sessionId}_${++counter}`, createdAt)
      current = applyStreamEvent(current, event)
    }
  }

  for (const line of lines) {
    const at = typeof line.timestamp === "string" ? line.timestamp : new Date(0).toISOString()

    if (line.type === "assistant") {
      // ONE BLOCK AT A TIME, deliberately. `streamEventsFor` skips assistant text
      // (live it arrives as `stream_event` token deltas the stored log doesn't
      // record), so text is emitted here instead — and replaying block-by-block
      // is what keeps that injected text interleaved with thinking and tool calls
      // in their original order rather than appended after them.
      for (const block of blocksOf(line)) {
        if (block.type === "text") {
          const text = String(block.text ?? "")
          if (text.length > 0) fold([{ _tag: "Assistant", text }], at)
          continue
        }
        fold(eventsFor({ ...line, message: { ...line.message!, content: [block] } }, tools), at)
      }
      continue
    }

    if (line.type === "user") {
      const prompt = promptTextOf(line)
      if (prompt !== null) {
        // A real prompt ends the previous turn and starts a new one.
        closeAssistant()
        out.push(userMessage(`u_${sessionId}_${++counter}`, prompt, at, []))
        continue
      }
      fold(eventsFor(line, tools), at)
    }
    // `attachment` / `last-prompt` / `mode` / `queue-operation` / `summary` lines
    // are harness bookkeeping with no transcript content.
  }
  closeAssistant()
  return out
}
