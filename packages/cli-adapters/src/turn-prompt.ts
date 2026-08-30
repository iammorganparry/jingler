/**
 * How a turn's prompt is assembled from the operator's message and the notes that
 * ride along with it.
 *
 * Every turn can carry prefixes for compaction, saved plans, output shaping,
 * private memory, structured questions, and the plan-mode protocol — and they
 * go in front of the message, in a fixed order, except when they must not. That
 * exception is a real bug that shipped: the runtime only expands a command
 * when it is the FIRST thing in the message, so prefixing a primer turned
 * `/babysit-pr …` into prose and the turn came back instantly with nothing to say.
 *
 * Pure, and separated from the run so the rule can be read and tested as a rule.
 * It used to be four interpolations and a ternary in the middle of a 900-line
 * function, which is a poor place to keep something with a documented trap in it.
 */

/** A slash command, e.g. `/plan` or `/babysit-pr foo` — expanded only when first. */
const SLASH_COMMAND = /^\/[A-Za-z][\w:-]*(\s|$)/
const SKILL_INVOCATION = /^\$[A-Za-z][\w:-]*(\s|$)/

export const isSlashCommand = (text: string): boolean =>
  SLASH_COMMAND.test(text.trimStart())

/**
 * A skill invocation, which has the same first-position requirement as a slash
 * command but its own syntax.
 */
export const isSkillInvocation = (text: string): boolean =>
  SKILL_INVOCATION.test(text.trimStart())

/** Whether pi will treat `text` as a command that has to lead. */
export const leadsWithCommand = (text: string): boolean =>
  isSlashCommand(text) || isSkillInvocation(text)

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
  /** Managed-tool precedence, including the visible in-app browser. */
  readonly tools?: string | null
  /** Research-first: verify current vendor docs before implementing against them. */
  readonly research?: string | null
  /** How to ask the operator a question so it actually reaches them. */
  readonly ask?: string | null
  /** How the agent submits a plan through Jingler's control tool. */
  readonly planProtocol?: string | null
}

/** The notes, in order, each followed by a blank line. Empty when there are none. */
const prefixOf = (notes: TurnNotes): string =>
  [notes.primer, notes.planPointer, notes.adhd, notes.memory, notes.tools, notes.research, notes.ask, notes.planProtocol]
    .filter((note): note is string => note !== null && note !== undefined && note !== "")
    .map((note) => `${note}\n\n`)
    .join("")

/** Keep harness-native integrations from silently bypassing Jingler's shared tools. */
export const managedToolsNote = (): string =>
  [
    "<managed-tools>",
    "For GitHub, prefer Jingler's host-provided GitHub commands. Use the authenticated `gh` CLI only when the current environment explicitly permits it; never print, request, or expose its token. Fall back to Jingler's attached MCP/OpenConnector GitHub tools when host commands and `gh` are unavailable. For every other provider, Jingler's attached MCP servers are the authoritative tool set; use OpenConnector before any harness-native equivalent.",
    "For browser interaction use the attached jingler-browser tools, which control the in-app browser visible to the operator. Do not use browser-use, Playwright MCP, or a harness browser plugin. Running the repository's own Playwright test suite as a normal shell command is still allowed when the task requires it.",
    "</managed-tools>"
  ].join("\n")

/**
 * The agent's trained knowledge of external libraries is stale by definition,
 * and the failure mode is silent: it implements a Clerk invite flow (or a
 * Stripe webhook, or a Next.js API surface) from memory, the code compiles,
 * and only review reveals it ignored the vendor's current recommended flow.
 * This note makes current-docs research a required first step for any work
 * that touches an external integration surface — while explicitly exempting
 * repo-local work, so it does not tax every refactor with a web search.
 */
export const researchFirstNote = (): string =>
  [
    "<research-first>",
    "Never assume your built-in knowledge of a third-party SDK, API, service, or framework is current. It is stale by definition: methods get renamed, flows get replaced, and vendors publish recommended patterns that did not exist when you learned the library. Working from memory here ships plausible-but-outdated code.",
    "",
    "Before implementing or reworking anything that touches an external integration surface — auth/invite flows, billing, webhooks, SDK calls, provider configuration, framework APIs — research first:",
    "1. Web-search for the vendor's CURRENT official docs or guide for the exact flow (e.g. \"clerk manage organization invitations custom flow\") and read the most relevant page(s) before writing code.",
    "2. Check the installed package version in this repository and match the docs to it; prefer the vendor's recommended flow over one reconstructed from memory.",
    "3. In your summary, cite the guide(s) you implemented against so the operator can verify the source.",
    "",
    "Skip the research only for purely repo-local work (refactors, tests over existing code, logic with no external surface). If web access is unavailable, say so explicitly instead of silently falling back to trained assumptions.",
    "</research-first>"
  ].join("\n")

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
