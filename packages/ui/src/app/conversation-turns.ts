import type { Message, ToolCall } from "@jingler/core"
import type { PreviewRailItemKind } from "../components/beui/overlays.js"

export interface TurnSummary {
  /** Why the rail tick is amber (a blocked question/gate) or red (the turn ended failed). */
  attention: Extract<PreviewRailItemKind, "needs-you" | "failed"> | undefined
  files: number
  added: number
  removed: number
}

const toolEdits = (tool: ToolCall): ReadonlyArray<{ path: string; added: number; removed: number }> => {
  if (tool.fileChanges) return tool.fileChanges.changes
  return tool.diff && tool.target ? [{ path: tool.target, ...tool.diff }] : []
}

const isBlocked = (part: Message["parts"][number]): boolean =>
  (part._tag === "Question" && part.answers === null) || (part._tag === "Gate" && part.gate.status === "pending")

const endedFailed = (lastTool: ToolCall | undefined, lastText: string): boolean =>
  lastTool?.status === "error" || lastText.startsWith("pi prompt failed")

/** What a turn (the assistant messages that answer one user message) did, for the rail tick and hover card. */
export const summarizeTurn = (turn: ReadonlyArray<Message>): TurnSummary => {
  const paths = new Set<string>()
  const parts = turn.flatMap(message => message.parts)
  const tools = parts.flatMap(part => (part._tag === "Tool" ? [part.tool] : []))
  const edits = tools.flatMap(toolEdits)
  for (const edit of edits) paths.add(edit.path)
  const lastText = parts.findLast(part => part._tag === "Text")
  const blocked = parts.some(isBlocked)
  const attention = blocked ? "needs-you" : endedFailed(tools.at(-1), lastText?._tag === "Text" ? lastText.text : "") ? "failed" : undefined
  return {
    attention,
    files: paths.size,
    added: edits.reduce((sum, edit) => sum + edit.added, 0),
    removed: edits.reduce((sum, edit) => sum + edit.removed, 0)
  }
}

/** `Turn 3 · 4 files · +84 −12`; the file stats are dropped for turns that changed nothing. */
export const turnRailMeta = (turn: number, summary: TurnSummary): string =>
  summary.files === 0
    ? `Turn ${turn}`
    : `Turn ${turn} · ${summary.files} file${summary.files === 1 ? "" : "s"} · +${summary.added} −${summary.removed}`
