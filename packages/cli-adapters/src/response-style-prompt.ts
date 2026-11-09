import type { ResponseStyle } from "@jingler/core"

const ADHD_RULES = [
  "RESPONSE FORMAT — MANDATORY (final completion summary):",
  "1. First line is an action — a command, a path, or a snippet. Never preamble.",
  "2. Number multi-step work; one bounded action per step.",
  '3. State final progress ("step 5 of 5 done") — never assume it is held.',
  '4. Give concrete time estimates ("15 minutes"), not "a bit of work".',
  "5. End with ONE next action doable in under two minutes.",
  "",
  'Cap lists at 5 items. State errors matter-of-factly — cause, then fix. Banned: "Great question", "Let me…", "Sure!", "Hope this helps", and recaps of what you just did.',
  'Override this only when the user asks you to "explain" or "walk me through" (then go long, still no preamble).'
].join("\n")

const BODY = {
  concise: [
    "Keep every reply to a couple of sentences: what changed or what you found, and anything the operator must act on.",
    "No headings, no file-by-file tours, no recaps. Keep paths, commands and numbers exact. The operator will ask for detail when they want it."
  ].join("\n"),
  balanced: [
    "Keep replies short and scannable: a one-line summary, then up to five bullets covering the key changes, risks, and how it was verified.",
    "Skip background the operator did not ask for."
  ].join("\n"),
  elaborate: [
    "Give full detail: what changed and why, file by file where useful, alternatives considered, trade-offs, how it was verified, and open questions.",
    "Use headings and code snippets where they help the operator follow along."
  ].join("\n"),
  adhd: ADHD_RULES
} satisfies Record<ResponseStyle, string>

const EVERY_REPLY = "Applies to every reply in this turn unless the operator explicitly asks for more or less detail."

// ADHD formatting (action first line, one next action) only makes sense once the work is done.
const COMPLETION_ONLY = [
  "Apply the format below only when the requested task is finished and you are delivering the final completion summary.",
  "Do not apply it to exploration, tool narration, working updates, planning, questions, permission requests, or errors while work remains; communicate naturally and briefly there."
].join("\n")

const SCOPE = {
  concise: EVERY_REPLY,
  balanced: EVERY_REPLY,
  elaborate: EVERY_REPLY,
  adhd: COMPLETION_ONLY
} satisfies Record<ResponseStyle, string>

/**
 * The response-style instruction, carried per turn so a Settings change applies
 * on the next message. Defined inline so it reads the same on every provider.
 */
export const responseStyleNote = (style: ResponseStyle): string =>
  `RESPONSE STYLE — ${style.toUpperCase()}:\n${SCOPE[style]}\n${BODY[style]}`
