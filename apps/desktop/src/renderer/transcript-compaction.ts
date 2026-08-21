import type { ContentPart, Message, ToolCall } from "@jingler/core"

/**
 * Renderer-side transcript compaction.
 *
 * `foldEvent` keeps every settled tool card whole — output, diff preview,
 * per-file previews — and on a long-running turn those cards accumulate on ONE
 * assistant message, which no message-count cap (`LIVE_HISTORY_CAP`) can ever
 * touch. Four busy sessions held resident by the registry (a running actor is
 * never evictable) each grow that way for hours; a renderer measured at 7.6GB
 * was mostly this.
 *
 * The fix is display-side only: past a recent window, a settled tool card's
 * heavy payloads are stripped from the LIVE message array. Nothing durable is
 * lost — main owns the transcript on disk and never compacts it, so "Load
 * earlier", a trim re-read, and the next app launch all decode the full
 * record (and are themselves re-compacted on the way in, so a giant on-disk
 * turn can't re-inflate the heap it took down).
 *
 * What survives compaction is exactly what a COLLAPSED card renders: name,
 * target, status, meta, diff stats, and per-file paths/counts. What goes is
 * only expanded-body content: `output`, the card-level `preview`, and each
 * `FileChange.preview`. `compacted: true` lets the card say so instead of
 * claiming "No output."
 */

/**
 * How many of a message's most recent tool cards keep their full payloads.
 *
 * Sized so an ordinary turn (a handful to a couple dozen tool calls) is never
 * touched — every card the operator is likely to expand stays whole — while a
 * runaway multi-hour turn is bounded to this window plus stripped headers.
 * Applied per message, so history pages hold full fidelity for every normal
 * turn they carry.
 */
export const KEEP_RECENT_TOOL_PARTS = 24

/** Whether compacting this card would actually release anything. */
const holdsHeavyPayload = (tool: ToolCall): boolean =>
  tool.status !== "running" &&
  tool.compacted !== true &&
  (tool.output !== undefined ||
    tool.preview !== null ||
    (tool.fileChanges?.changes.some((c) => c.preview !== null) ?? false))

const compactToolCall = (tool: ToolCall): ToolCall => {
  // Destructure-drop rather than assign undefined: `output` is optional-absent
  // in the schema, and a present-and-undefined key re-encodes differently.
  const { output: _output, ...kept } = tool
  return {
    ...kept,
    preview: null,
    ...(tool.fileChanges !== undefined
      ? {
          fileChanges: {
            ...tool.fileChanges,
            changes: tool.fileChanges.changes.map((c) =>
              c.preview === null ? c : { ...c, preview: null }
            )
          }
        }
      : {}),
    compacted: true
  }
}

/**
 * Strip heavy payloads from every settled tool card older than the message's
 * `keepRecentTools` most recent ones. Returns the SAME reference when there is
 * nothing to do, so callers can fold this per stream event without defeating
 * identity-based render comparators.
 */
export const compactMessageParts = (
  msg: Message,
  keepRecentTools: number = KEEP_RECENT_TOOL_PARTS
): Message => {
  // Index of the keep-window's oldest tool part; tools strictly before it are
  // out of the window. A message with fewer tools than the window has nothing
  // old enough to compact.
  const cutoff = ((): number => {
    if (keepRecentTools <= 0) return msg.parts.length
    let seen = 0
    for (let i = msg.parts.length - 1; i >= 0; i--) {
      if (msg.parts[i]!._tag === "Tool" && ++seen === keepRecentTools) return i
    }
    return -1
  })()
  if (cutoff <= 0) return msg

  let changed = false
  const parts = msg.parts.map((p, i): ContentPart => {
    if (i >= cutoff || p._tag !== "Tool" || !holdsHeavyPayload(p.tool)) return p
    changed = true
    return { _tag: "Tool", tool: compactToolCall(p.tool) }
  })
  return changed ? { ...msg, parts } : msg
}

/**
 * Compact a whole array of messages (a loaded tail, a history page). Reference-
 * preserving per element for the same reason as `compactMessageParts`.
 */
export const compactMessages = (
  messages: ReadonlyArray<Message>,
  keepRecentTools: number = KEEP_RECENT_TOOL_PARTS
): ReadonlyArray<Message> => {
  let changed = false
  const next = messages.map((m) => {
    const compacted = compactMessageParts(m, keepRecentTools)
    if (compacted !== m) changed = true
    return compacted
  })
  return changed ? next : messages
}
