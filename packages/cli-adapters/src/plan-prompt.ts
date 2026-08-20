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

/**
 * Per-turn nudge for operator messages that arrive while an approved plan is
 * executing: the plan stays the ground truth, and the new request folds into
 * it instead of derailing it. The current checkpoint state rides along so the
 * agent always has the exact stage/task ids and fingerprints to mark against.
 */
export const planExecutionNote = (
  checkpoints: ReadonlyArray<string> = []
): string => [
  "PLAN EXECUTION — an approved plan is in progress in this session.",
  "Fold this message into the plan: FIRST call jingler_submit_plan with the complete updated plan (it applies immediately mid-execution, no re-approval), say where the addition landed, and keep driving the plan to completion.",
  "The plan's task list is the operator's live progress view — treat it as your scratchpad. Emit a PLAN_TASK checkpoint the moment any task starts (in-progress), completes, or blocks, and PLAN_RESULT evidence lines for acceptance criteria you verify:",
  "PLAN_TASK stage=<stage-id> fingerprint=<fingerprint> task=<task-id> status=<in-progress|completed|blocked>",
  "Markers must use ids from the current plan — a marker naming an unknown stage or task is dropped and the operator never sees that progress. Submit the amended plan before marking new work.",
  "Implement plan stages YOURSELF, in this turn — never hand a plan task's implementation to a subagent. Subagents are only for bounded read-only side-lookups that feed your implementation.",
  "THIS turn's active tool list is the only authority on what you can do. Statements earlier in this conversation about missing edit or command tools are STALE — the toolset is rebuilt per turn. Never mark a task blocked on a missing tool without attempting the call in this turn; if it truly fails, quote the actual error.",
  ...(checkpoints.length === 0
    ? []
    : ["", "Current execution checkpoints:", ...checkpoints])
].join("\n")
