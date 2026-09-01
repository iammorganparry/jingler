import type { PlanPrdStage, PlanStageExecutionStatus } from "./plan-document.js"

/** Derive stage progress from Plannotator's task and acceptance markers. */
export const planStageExecutionStatus = (stage: PlanPrdStage): PlanStageExecutionStatus => {
  const tasks = stage.tasks ?? []
  if (tasks.some((task) => task.status === "blocked")) return "blocked"
  if (stage.acceptance.some((criterion) => criterion.status === "failed")) return "failed"
  if (tasks.some((task) => task.status === "in-progress")) return "running"

  const acceptanceDone = stage.acceptance.every(
    (criterion) => criterion.status === "passed" || criterion.status === "waived"
  )
  const tasksDone = tasks.every((task) => task.status === "completed")
  if ((tasks.length > 0 || stage.acceptance.length > 0) && tasksDone && acceptanceDone) {
    return "completed"
  }
  if (
    tasks.some((task) => task.status === "completed") ||
    stage.acceptance.some((criterion) =>
      criterion.status === "passed" || criterion.status === "waived"
    )
  ) return "running"
  return "queued"
}
