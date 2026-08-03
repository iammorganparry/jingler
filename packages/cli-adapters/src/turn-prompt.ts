import type { CliKind } from "@jingler/core"

/**
 * How a turn's prompt is assembled from the operator's message and the notes that
 * ride along with it.
 *
 * Every turn can carry prefixes for compaction, saved plans, output shaping,
 * private memory, structured questions, and the plan-mode protocol — and they
 * go in front of the message, in a fixed order, except when they must not. That
 * exception is a real bug that shipped: a harness only expands a slash command
 * when it is the FIRST thing in the message, so prefixing a primer turned
 * `/babysit-pr …` into prose and the turn came back instantly with nothing to say.
 *
 * Pure, and separated from the run so the rule can be read and tested as a rule.
 * It used to be four interpolations and a ternary in the middle of a 900-line
 * function, which is a poor place to keep something with a documented trap in it.
 */

/** A slash command, e.g. `/plan` or `/babysit-pr foo` — expanded only when first. */
export const isSlashCommand = (text: string): boolean =>
  /^\/[A-Za-z][\w:-]*(\s|$)/.test(text.trimStart())

/**
 * Codex's own skill invocation, which has the same first-position requirement as a
 * slash command but none of the syntax.
 */
export const isCodexSkillInvocation = (text: string): boolean =>
  /^\$[A-Za-z][\w:-]*(\s|$)/.test(text.trimStart())

/**
 * Whether this harness will treat `text` as a command that has to lead.
 *
 * Asked of the harness as well as the text because the syntaxes differ: only Codex
 * treats a `$skill` prefix specially, and mistaking one for a command elsewhere
 * would push the notes after a message that never needed to lead.
 */
export const leadsWithCommand = (cli: CliKind, text: string): boolean =>
  isSlashCommand(text) || (cli === "codex" && isCodexSkillInvocation(text))

/**
 * The notes that ride in front of a turn, in the order they are emitted.
 *
 * Each is `null` when it does not apply. The ORDER is the domain knowledge this
 * module exists to hold, so it is fixed here rather than at the call site.
 */
export interface TurnNotes {
  /** The compaction primer: what the summarised conversation established. */
  readonly primer?: string | null
  /** Where the worktree's saved plan lives. */
  readonly planPointer?: string | null
  /** ADHD final-summary shaping, when the operator has it on. */
  readonly adhd?: string | null
  /** Stateless, evidence-first team-memory instructions when attachment succeeded. */
  readonly memory?: string | null
  /** How to ask the operator a question so it actually reaches them. */
  readonly ask?: string | null
  /** How this harness is expected to submit a plan. */
  readonly planProtocol?: string | null
}

/** The notes, in order, each followed by a blank line. Empty when there are none. */
const prefixOf = (notes: TurnNotes): string =>
  [notes.primer, notes.planPointer, notes.adhd, notes.memory, notes.ask, notes.planProtocol]
    .filter((note): note is string => note !== null && note !== undefined && note !== "")
    .map((note) => `${note}\n\n`)
    .join("")

/**
 * Build the prompt text for a turn.
 *
 * `leadWithText` puts the operator's message first and the notes after it — the
 * slash-command case. The trailing whitespace is trimmed there because the notes
 * end in a blank line that would otherwise dangle at the end of the message.
 */
export const composeTurnPrompt = (
  text: string,
  notes: TurnNotes,
  options: { readonly leadWithText: boolean }
): string => {
  const prefix = prefixOf(notes)
  return options.leadWithText ? `${text}\n\n${prefix}`.trimEnd() : `${prefix}${text}`
}

/**
 * A concise context note prepended to a run when the session's worktree has saved
 * plan(s). It does two jobs: (1) anchor the agent to its worktree, and (2) hand it
 * the plan file path(s).
 *
 * (1) matters because the plan library lives OUTSIDE the worktree
 * (`~/jingler/.jingler/…`): without being told its working directory, an agent
 * that reads the plan file can mistake the plan's parent for the project root and
 * `cd` out of its worktree (even into the origin checkout) — corrupting the wrong
 * tree. So we state the worktree path explicitly and forbid treating the plan's
 * location as the repo. Phrased so the agent only acts on the plan when the turn
 * is actually about it.
 */
export const planPointerNote = (worktreePath: string, planFiles: ReadonlyArray<string>): string =>
  [
    "<session-context>",
    `Working directory (this session's git worktree — the project root): ${worktreePath}`,
    "Do ALL work here: every file read/edit and shell command runs in this directory. Do NOT `cd` out of it, and never treat any other directory as the project — in particular, the plan file below lives OUTSIDE the project, so its parent directory is NOT the repo.",
    "",
    "Saved plan for this session (a read-only reference document, not part of the project):",
    ...planFiles.map((f) => `  - ${f}`),
    "If this message asks you to implement, continue, or pick up the plan, read that file to recall the full plan, then do the work in the working directory above. Otherwise ignore this note.",
    "</session-context>"
  ].join("\n")
