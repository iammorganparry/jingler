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
  "When you delegate stage work to sub-agents, put the checkpoint contract in each worker's task prompt: give it the exact stage id, fingerprint, and task ids it owns, and require it to emit the same PLAN_TASK lines as each task starts, completes, or blocks. Worker checkpoints update the plan live — without them the operator watches a frozen plan for the whole delegation.",
  ...(checkpoints.length === 0
    ? []
    : ["", "Current execution checkpoints:", ...checkpoints])
].join("\n")
