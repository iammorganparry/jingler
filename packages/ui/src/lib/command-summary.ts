/**
 * A pure, UI-agnostic summary of a (possibly multi-line) shell command awaiting
 * approval: how many lines it has, and a single display line safe for a
 * notification body or sidebar row. Shared by `ApprovalGate`'s "Show all · N
 * lines" toggle and the desktop notifier so the two never drift on what "one
 * line" of a command means.
 */

const SUMMARY_MAX = 60

/** How many lines `cmd` spans — drives whether the collapse toggle shows at all. */
export const commandLineCount = (cmd: string): number => cmd.split("\n").length

/** First line, whitespace-normalised, truncated to ~60 chars with an ellipsis, e.g. "Run pnpm test --filter …". */
export const commandSummary = (cmd: string): string => {
  const line = cmd.split("\n")[0]!.replace(/\s+/g, " ").trim()
  const text = line.length > SUMMARY_MAX ? `${line.slice(0, SUMMARY_MAX - 1).trimEnd()}…` : line
  return `Run ${text}`
}
