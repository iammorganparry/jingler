/**
 * Completion-summary rules owned by Jingler rather than a provider harness.
 */
const INLINE_RULES = [
  "RESPONSE FORMAT — MANDATORY:",
  "1. First line is an action — a command, a path, or a snippet. Never preamble.",
  "2. Number multi-step work; one bounded action per step.",
  '3. State final progress ("step 5 of 5 done") — never assume it is held.',
  '4. Give concrete time estimates ("15 minutes"), not "a bit of work".',
  "5. End with ONE next action doable in under two minutes.",
  "",
  'Cap lists at 5 items. State errors matter-of-factly — cause, then fix. Banned: "Great question", "Let me…", "Sure!", "Hope this helps", and recaps of what you just did.',
  'Override this only when the user asks you to "explain" or "walk me through" (then go long, still no preamble).'
].join("\n")

const COMPLETION_SCOPE = [
  "ADHD RESPONSE FORMAT SCOPE — MANDATORY:",
  "Apply the rules below only when the requested task is finished and you are delivering the final completion summary.",
  "Do not apply them to exploration, tool narration, working updates, planning, questions, permission requests, or errors while work remains.",
  "During those intermediate replies, communicate naturally and briefly."
].join("\n")

/**
 * The ADHD completion-summary instruction, carried per turn so a Settings
 * change applies immediately but explicitly dormant until the task is finished.
 *
 * Managed skills remain lower-trust resources, so product behavior is defined
 * inline and stays identical across provider models.
 */
export const adhdNote = (): string => `${COMPLETION_SCOPE}\n\n${INLINE_RULES}`
