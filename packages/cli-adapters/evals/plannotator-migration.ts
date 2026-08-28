export type PlannotatorEvalPhase = "idle" | "planning" | "executing"
export type NativeProjectionTarget = "todo" | "drawer" | "progress" | "composer" | "transcript"

export type PlannotatorEvalEvent =
  | { readonly kind: "phase"; readonly phase: PlannotatorEvalPhase }
  | { readonly kind: "tool"; readonly name: string }
  | { readonly kind: "review"; readonly url: string; readonly sandboxed: boolean }
  | { readonly kind: "decision"; readonly outcome: "feedback" | "approved" | "approved-with-notes" | "cancelled" | "failed"; readonly notes?: string }
  | { readonly kind: "execution-context"; readonly text: string }
  | { readonly kind: "checklist"; readonly completed: ReadonlyArray<number>; readonly total: number }
  | { readonly kind: "projection"; readonly target: NativeProjectionTarget; readonly completed: ReadonlyArray<number>; readonly total: number }
  | { readonly kind: "restart"; readonly planExists: boolean }

export interface PlannotatorEvalScenario {
  readonly id: string
  readonly events: ReadonlyArray<PlannotatorEvalEvent>
}

export interface PlannotatorEvalFailure {
  readonly scenarioId: string
  readonly rule: string
}

const PLANNING_TOOLS = new Set([
  "read",
  "grep",
  "find",
  "ls",
  "write",
  "edit",
  "plannotator_submit_plan"
])
const PROJECTION_TARGETS: ReadonlyArray<NativeProjectionTarget> = [
  "todo",
  "drawer",
  "progress",
  "composer",
  "transcript"
]

const sameProgress = (
  left: Pick<Extract<PlannotatorEvalEvent, { kind: "checklist" }>, "completed" | "total">,
  right: Pick<Extract<PlannotatorEvalEvent, { kind: "projection" }>, "completed" | "total">
): boolean => left.total === right.total && left.completed.join(",") === right.completed.join(",")

export const evaluatePlannotatorScenario = (
  scenario: PlannotatorEvalScenario
): ReadonlyArray<PlannotatorEvalFailure> => {
  const failures: PlannotatorEvalFailure[] = []
  const fail = (rule: string) => failures.push({ scenarioId: scenario.id, rule })
  let phase: PlannotatorEvalPhase = "idle"
  let approved = false
  let blockedExecution = false
  let feedbackPending = false
  let approvalNotes: string | null = null
  let lastCompleted: ReadonlyArray<number> = []

  scenario.events.forEach((event, index) => {
    if (event.kind === "restart") {
      blockedExecution = !event.planExists
      return
    }
    if (event.kind === "decision") {
      if (event.outcome === "feedback") {
        feedbackPending = true
        approved = false
      } else if (event.outcome === "approved" || event.outcome === "approved-with-notes") {
        approved = true
        blockedExecution = false
        approvalNotes = event.outcome === "approved-with-notes" ? event.notes?.trim() || null : null
      } else {
        approved = false
        blockedExecution = true
      }
      return
    }
    if (event.kind === "phase") {
      if (event.phase === "planning") feedbackPending = false
      if (event.phase === "executing") {
        if (!approved) fail("execution-requires-approval")
        if (blockedExecution) fail("cancel-failure-or-missing-plan-must-not-execute")
        if (feedbackPending) fail("feedback-must-return-to-planning-before-execution")
      }
      phase = event.phase
      return
    }
    if (event.kind === "tool" && phase === "planning" && !PLANNING_TOOLS.has(event.name)) {
      fail(`planning-tool-forbidden:${event.name}`)
      return
    }
    if (event.kind === "review") {
      try {
        const url = new URL(event.url)
        if (url.protocol !== "http:" || !["localhost", "127.0.0.1", "::1"].includes(url.hostname)) {
          fail("review-must-use-loopback-http")
        }
      } catch {
        fail("review-must-use-loopback-http")
      }
      if (!event.sandboxed) fail("review-must-be-sandboxed")
      return
    }
    if (event.kind === "execution-context" && approvalNotes !== null) {
      if (!event.text.includes(approvalNotes)) fail("approval-notes-must-reach-execution")
      approvalNotes = null
      return
    }
    if (event.kind === "checklist") {
      const ordered = event.completed.every((step, stepIndex) => step === stepIndex + 1)
      if (!ordered || event.completed.length < lastCompleted.length) {
        fail("checklist-progress-must-be-ordered-and-monotonic")
      }
      const untilNextChecklist = scenario.events.slice(index + 1).findIndex((candidate) => candidate.kind === "checklist")
      const end = untilNextChecklist < 0 ? scenario.events.length : index + 1 + untilNextChecklist
      const projections = scenario.events.slice(index + 1, end).filter(
        (candidate): candidate is Extract<PlannotatorEvalEvent, { kind: "projection" }> => candidate.kind === "projection"
      )
      for (const target of PROJECTION_TARGETS) {
        const projection = projections.find((candidate) => candidate.target === target)
        if (!projection || !sameProgress(event, projection)) fail(`projection-out-of-sync:${target}`)
      }
      lastCompleted = event.completed
    }
  })

  if (approvalNotes !== null) fail("approval-notes-must-reach-execution")
  return failures
}

const projections = (completed: ReadonlyArray<number>, total: number): ReadonlyArray<PlannotatorEvalEvent> =>
  PROJECTION_TARGETS.map((target) => ({ kind: "projection", target, completed, total }))

export const PLANNOTATOR_EVAL_MATRIX: ReadonlyArray<PlannotatorEvalScenario> = [
  {
    id: "planning.restricted-tools",
    events: [
      { kind: "phase", phase: "planning" },
      { kind: "tool", name: "read" },
      { kind: "tool", name: "write" },
      { kind: "tool", name: "plannotator_submit_plan" }
    ]
  },
  {
    id: "review.feedback-resubmission",
    events: [
      { kind: "phase", phase: "planning" },
      { kind: "review", url: "http://localhost:19432", sandboxed: true },
      { kind: "decision", outcome: "feedback" },
      { kind: "phase", phase: "planning" },
      { kind: "tool", name: "edit" },
      { kind: "review", url: "http://127.0.0.1:19433", sandboxed: true },
      { kind: "decision", outcome: "approved" },
      { kind: "phase", phase: "executing" }
    ]
  },
  {
    id: "execution.approval-notes-and-progress",
    events: [
      { kind: "phase", phase: "planning" },
      { kind: "decision", outcome: "approved-with-notes", notes: "Keep the migration reversible" },
      { kind: "phase", phase: "executing" },
      { kind: "execution-context", text: "Keep the migration reversible" },
      { kind: "checklist", completed: [1], total: 2 },
      ...projections([1], 2),
      { kind: "checklist", completed: [1, 2], total: 2 },
      ...projections([1, 2], 2),
      { kind: "phase", phase: "idle" }
    ]
  },
  {
    id: "recovery.cancelled-review",
    events: [
      { kind: "phase", phase: "planning" },
      { kind: "review", url: "http://localhost:19434", sandboxed: true },
      { kind: "decision", outcome: "cancelled" },
      { kind: "phase", phase: "idle" }
    ]
  },
  {
    id: "recovery.review-ui-failure",
    events: [
      { kind: "phase", phase: "planning" },
      { kind: "decision", outcome: "failed" },
      { kind: "phase", phase: "idle" }
    ]
  },
  {
    id: "recovery.restart-with-plan",
    events: [
      { kind: "restart", planExists: true },
      { kind: "phase", phase: "planning" },
      { kind: "decision", outcome: "approved" },
      { kind: "phase", phase: "executing" }
    ]
  },
  {
    id: "recovery.restart-missing-plan",
    events: [
      { kind: "restart", planExists: false },
      { kind: "phase", phase: "idle" }
    ]
  },
  {
    id: "projection.all-native-surfaces",
    events: [
      { kind: "decision", outcome: "approved" },
      { kind: "phase", phase: "executing" },
      { kind: "checklist", completed: [1], total: 1 },
      ...projections([1], 1)
    ]
  }
]

export const evaluatePlannotatorMatrix = (
  matrix: ReadonlyArray<PlannotatorEvalScenario> = PLANNOTATOR_EVAL_MATRIX
): ReadonlyArray<PlannotatorEvalFailure> => matrix.flatMap(evaluatePlannotatorScenario)
