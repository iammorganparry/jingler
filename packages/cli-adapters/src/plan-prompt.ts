/**
 * Per-turn planning policy. The exact plan schema is already attached to
 * `jingler_submit_plan`, so this note describes control flow instead of copying
 * the schema into another prompt surface.
 */
export const planNote = (): string => [
  "PLAN MODE — you are READ-ONLY this turn. Mutation and execution tools are unavailable.",
  "Research the repository, then call `jingler_submit_plan` with the complete structured plan.",
  "Do not emit a plan as prose or a fenced JSON block."
].join("\n")
