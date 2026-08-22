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
 *
 * Text/Thinking parts are bounded on their own axis: past a recent window,
 * an oversized part keeps a readable prefix plus an in-text elision note (no
 * schema change — the note renders as ordinary markdown, and the full text
 * comes back on any whole-array re-read, same as tool cards).
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

/**
 * How many of a message's most recent Text/Thinking parts keep their full
 * text. Tool cards have their own window above; reasoning-heavy turns grow on
 * a different axis — extended thinking streams megabytes of `Thinking.text`
 * that `holdsHeavyPayload` never looked at — so the two windows are counted
 * independently.
 */
export const KEEP_RECENT_TEXT_PARTS = 8

/**
 * Past the recent-text window, a Text/Thinking part longer than this keeps
 * only this many leading UTF-16 code units plus an elision note. Sized so any
 * humanly-readable reasoning block survives whole; only runaway blocks are
 * cut.
 */
export const MAX_TEXT_PART_CHARS = 16 * 1024

/**
 * The fixed tail of the elision note. Detection key for idempotency: a part
 * ending in this was already elided and must not be cut again (re-slicing
 * would drop the note and stack a new one). Plain text on purpose — it lands
 * inside rendered markdown.
 */
const ELIDED_TEXT_SUFFIX =
  "released from memory — full text is in the session transcript]"

const elideText = (text: string): string => {
  const released = text.length - MAX_TEXT_PART_CHARS
  const kb = Math.max(1, Math.round(released / 1024))
  return `${text.slice(0, MAX_TEXT_PART_CHARS)}\n\n[… ${kb}KB ${ELIDED_TEXT_SUFFIX}`
}

/** Whether eliding this Text/Thinking part would actually release anything. */
const holdsHeavyText = (text: string): boolean =>
  text.length > MAX_TEXT_PART_CHARS && !text.endsWith(ELIDED_TEXT_SUFFIX)

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
  keepRecentTools: number = KEEP_RECENT_TOOL_PARTS,
  keepRecentTexts: number = KEEP_RECENT_TEXT_PARTS
): Message => {
  // Index of a keep-window's oldest part of the counted kind; parts of that
  // kind strictly before it are out of the window. A message with fewer such
  // parts than the window has nothing old enough to compact. The two windows
  // are independent axes: a tool-heavy turn and a reasoning-heavy turn are
  // each bounded on their own. The rolling (still-streaming) part is always
  // the message's LAST part, so with a window of at least one it can never be
  // elided mid-delta.
  const cutoffOf = (counts: (p: ContentPart) => boolean, keep: number): number => {
    if (keep <= 0) return msg.parts.length
    let seen = 0
    for (let i = msg.parts.length - 1; i >= 0; i--) {
      if (counts(msg.parts[i]!) && ++seen === keep) return i
    }
    return -1
  }
  const toolCutoff = cutoffOf((p) => p._tag === "Tool", keepRecentTools)
  const textCutoff = cutoffOf(
    (p) => p._tag === "Text" || p._tag === "Thinking",
    keepRecentTexts
  )
  if (toolCutoff <= 0 && textCutoff <= 0) return msg

  let changed = false
  const parts = msg.parts.map((p, i): ContentPart => {
    if (i < toolCutoff && p._tag === "Tool" && holdsHeavyPayload(p.tool)) {
      changed = true
      return { _tag: "Tool", tool: compactToolCall(p.tool) }
    }
    if (
      i < textCutoff &&
      (p._tag === "Text" || p._tag === "Thinking") &&
      holdsHeavyText(p.text)
    ) {
      changed = true
      return { ...p, text: elideText(p.text) }
    }
    return p
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
