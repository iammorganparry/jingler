/**
 * Why the rule exists, stated once for every provider model.
 *
 * The "stop and wait" half is load-bearing. A model that asks and then guesses
 * in the same reply has not really asked — the operator's answer arrives after
 * the work is already done, and the question card becomes a receipt for a
 * decision they never made.
 */
const WHY = [
  "ASKING QUESTIONS — MANDATORY:",
  "Whenever you need a decision from the user — an ambiguous requirement, a choice between approaches, a missing value, anything you would otherwise guess at — you MUST ask through the structured question channel described below. Never ask in prose.",
  "",
  "A question asked in prose does not reach the user as a question: it renders as ordinary chat text with no way to answer it, so it is silently ignored and you end up guessing anyway.",
  "",
  "When you ask: stop and wait for the answer. Do not ask and then proceed on an assumption in the same reply.",
  "Do not ask when a sensible default exists, when the codebase already answers it, or to confirm work you were plainly asked to do — take the obvious option and say which you took."
].join("\n")

/**
 * Per-turn instruction for Jingler's one structured question channel.
 */
export const questionNote = (): string =>
  `${WHY}\n\nCall \`jingler_ask_question\`. It is the only channel that reaches the operator as an answerable question.`
