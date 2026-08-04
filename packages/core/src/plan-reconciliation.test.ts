import { describe, expect, it } from "vitest"
import type {
  PlanAcceptance,
  PlanAnnotation,
  PlanPrd,
  PlanPrdStage,
  PlanStageAssignment,
  PlanStageExecutionStatus
} from "./plan-document.js"
import {
  planStageSemanticFingerprint,
  reconcilePlanAmendment
} from "./plan-reconciliation.js"

const criterion = (
  id: string,
  text: string,
  status: PlanAcceptance["status"] = "pending",
  evidence: string | null = null
): PlanAcceptance => ({ id, text, status, evidence })

const assignment = (
  agentId: string,
  extra: Partial<PlanStageAssignment> = {}
): PlanStageAssignment => ({
  agentId,
  cli: "codex",
  model: "gpt-5",
  reason: "Stable component owner.",
  ...extra
})

const stage = (id: string, overrides: Partial<PlanPrdStage> = {}): PlanPrdStage => ({
  id,
  title: `Stage ${id}`,
  intent: `Intent ${id}`,
  approach: [],
  files: [],
  diagrams: [],
  notes: [],
  acceptance: [],
  dependencies: [],
  assignment: null,
  executionStatus: "queued",
  ...overrides
})

const plan = (
  stages: ReadonlyArray<PlanPrdStage>,
  annotations: ReadonlyArray<PlanAnnotation> = []
): PlanPrd => ({
  title: "PRD: Test",
  sections: [],
  stages: [...stages],
  annotations: [...annotations]
})

const annotation = (
  id: string,
  overrides: Partial<PlanAnnotation> = {}
): PlanAnnotation => ({
  id,
  stageId: "01",
  body: "Note",
  author: "user",
  createdAt: "2026-07-31T08:00:00.000Z",
  messages: [],
  status: "open",
  ...overrides
})

describe("reconcilePlanAmendment", () => {
  it("requeues changed work and invalidates evidence collected for its prior semantics", () => {
    const previous = plan([
      stage("01", {
        complexity: "high",
        assignment: assignment("worker-a"),
        executionStatus: "completed",
        notes: [{ kind: "prose", id: "n1", text: "Original implementation detail." }],
        acceptance: [criterion("01.1", "The stable behavior works.", "passed", "unit test green")]
      })
    ])
    const replacement = plan([
      stage("01", {
        complexity: "high",
        assignment: assignment("worker-b"),
        notes: [{ kind: "prose", id: "n1", text: "New user requirement for the same component." }],
        acceptance: [
          criterion("01.1", "The stable behavior works."),
          criterion("01.2", "The added behavior works.", "passed", "unverified")
        ]
      })
    ])

    const result = reconcilePlanAmendment(previous, replacement)

    expect(result.valid).toBe(true)
    if (!result.valid) return
    const changed = result.plan.stages[0]!
    expect(changed.assignment?.agentId).toBe("worker-a")
    expect(changed.executionStatus).toBe("queued")
    expect(changed.acceptance).toEqual([
      { id: "01.1", text: "The stable behavior works.", status: "pending", evidence: null },
      { id: "01.2", text: "The added behavior works.", status: "pending", evidence: null }
    ])
    expect(result.changedStageIds).toEqual(["01"])
  })

  it("reopens a changed completed stage while leaving an unchanged completed stage intact", () => {
    const previous = plan([
      stage("01", {
        title: "Changed",
        complexity: "medium",
        assignment: assignment("worker-a"),
        executionStatus: "completed",
        acceptance: [criterion("01.1", "The old behavior works.", "passed", "old assertion")]
      }),
      stage("02", {
        title: "Unchanged",
        complexity: "low",
        assignment: assignment("worker-b"),
        executionStatus: "completed",
        acceptance: [criterion("02.1", "The stable behavior works.", "passed", "still green")]
      })
    ])
    const replacement = plan([
      stage("01", {
        title: "Changed",
        complexity: "high",
        assignment: assignment("replacement-owner"),
        executionStatus: "completed",
        acceptance: [criterion("01.1", "The revised behavior works.", "passed", "must be discarded")]
      }),
      stage("02", {
        title: "Unchanged",
        complexity: "low",
        assignment: assignment("replacement-owner-2"),
        acceptance: [criterion("02.1", "The stable behavior works.")]
      })
    ])

    const result = reconcilePlanAmendment(previous, replacement)

    expect(result.valid).toBe(true)
    if (!result.valid) return
    const changed = result.plan.stages[0]!
    expect(changed.assignment?.agentId).toBe("worker-a")
    expect(changed.executionStatus).toBe("queued")
    expect(changed.acceptance[0]).toMatchObject({
      text: "The revised behavior works.",
      status: "pending",
      evidence: null
    })

    const unchanged = result.plan.stages[1]!
    expect(unchanged.assignment?.agentId).toBe("worker-b")
    expect(unchanged.executionStatus).toBe("completed")
    expect(unchanged.acceptance[0]).toMatchObject({ status: "passed", evidence: "still green" })
    expect(result.changedStageIds).toEqual(["01"])
  })

  const semanticChanges: ReadonlyArray<
    readonly [string, (stage: PlanPrdStage) => PlanPrdStage]
  > = [
    ["intent", (s) => ({ ...s, intent: "Revised intent." })],
    ["declared files", (s) => ({ ...s, files: [{ path: "src/revised.ts", change: "M" }] })],
    ["dependencies", (s) => ({ ...s, dependencies: ["20"] })],
    ["complexity", (s) => ({ ...s, complexity: "high" })]
  ]

  it.each(semanticChanges)(
    "invalidates same-text evidence when a stage changes its %s",
    (_change, amend) => {
      const changedStage = stage("01", {
        dependencies: ["10"],
        complexity: "medium",
        assignment: assignment("worker-a"),
        executionStatus: "completed",
        intent: "Original intent.",
        files: [{ path: "src/original.ts", change: "M" }],
        acceptance: [criterion("01.1", "The behavior works.", "passed", "old proof")]
      })
      const prerequisite = stage("10", {
        complexity: "medium",
        assignment: assignment("worker-a"),
        executionStatus: "completed",
        acceptance: [criterion("10.1", "The first prerequisite works.", "passed", "prerequisite proof")]
      })
      const previous = plan([prerequisite, changedStage])
      const replacement = plan([prerequisite, amend(changedStage)])

      const result = reconcilePlanAmendment(previous, replacement)

      expect(result.valid).toBe(true)
      if (!result.valid) return
      expect(result.changedStageIds).toEqual(["01"])
      expect(result.plan.stages.find((s) => s.id === "01")).toMatchObject({
        executionStatus: "queued",
        acceptance: [{ id: "01.1", text: "The behavior works.", status: "pending", evidence: null }]
      })
      expect(result.plan.stages.find((s) => s.id === "10")).toMatchObject({
        executionStatus: "completed",
        acceptance: [{ status: "passed", evidence: "prerequisite proof" }]
      })
    }
  )

  it("rejects removing a stage while its worker is running", () => {
    const previous = plan([
      stage("01", {
        assignment: assignment("worker-a"),
        executionStatus: "running",
        acceptance: [criterion("01.1", "The work completes.")]
      })
    ])
    const replacement = plan([
      stage("02", { acceptance: [criterion("02.1", "Replacement works.")] })
    ])

    const result = reconcilePlanAmendment(previous, replacement)

    expect(result.valid).toBe(false)
    if (result.valid) return
    expect(result.diagnostics).toContainEqual({
      code: "running-stage-removed",
      message: 'Running stage "01" cannot be removed. Stop its worker before removing the stage.',
      stageId: "01"
    })
  })

  it("accepts a replacement route while retaining a compatible logical agent id", () => {
    const previous = plan([
      stage("01", {
        complexity: "medium",
        assignment: assignment("worker-a"),
        acceptance: [criterion("01.1", "The work completes.")]
      })
    ])
    const replacement = plan([
      stage("01", {
        complexity: "high",
        assignment: assignment("replacement", {
          cli: "claude",
          model: "opus",
          reasoning: { enabled: true, effort: "max" },
          reason: "Updated high-complexity route."
        }),
        acceptance: [criterion("01.1", "The work completes.")]
      })
    ])

    const result = reconcilePlanAmendment(previous, replacement)

    expect(result.valid).toBe(true)
    if (!result.valid) return
    expect(result.plan.stages[0]?.assignment).toMatchObject({
      agentId: "worker-a",
      cli: "claude",
      model: "opus",
      reasoning: { enabled: true, effort: "max" }
    })
  })

  it("preserves a running worker's complete reasoning route", () => {
    const previous = plan([
      stage("01", {
        complexity: "high",
        assignment: assignment("worker-a", { reasoning: { enabled: true, effort: "high" }, reason: "Live route." }),
        executionStatus: "running",
        acceptance: [criterion("01.1", "The work completes.")]
      })
    ])
    const replacement = plan([
      stage("01", {
        complexity: "high",
        assignment: assignment("replacement", { reasoning: { enabled: true, effort: "low" }, reason: "Proposed route." }),
        acceptance: [criterion("01.1", "The work completes.")]
      })
    ])

    const result = reconcilePlanAmendment(previous, replacement)

    expect(result.valid).toBe(true)
    if (!result.valid) return
    expect(result.plan.stages[0]?.assignment).toMatchObject({
      agentId: "worker-a",
      reasoning: { enabled: true, effort: "high" }
    })
  })

  it("preserves prior user comments and unresolved worker annotations", () => {
    const previous = plan(
      [stage("01", { assignment: assignment("worker-a"), acceptance: [criterion("01.1", "The work completes.")] })],
      [
        annotation("user-note", { author: "user", body: "Keep the accessibility requirement." }),
        annotation("worker-note", { author: "agent", body: "Waiting for a fixture." })
      ]
    )
    const replacement = plan([
      stage("01", { assignment: assignment("worker-a"), acceptance: [criterion("01.1", "The work completes.")] })
    ])

    const result = reconcilePlanAmendment(previous, replacement)

    expect(result.valid).toBe(true)
    if (!result.valid) return
    expect(result.plan.annotations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "user-note", author: "user", status: "open" }),
        expect.objectContaining({ id: "worker-note", author: "agent", status: "open" })
      ])
    )
  })

  it("merges new agent replies into prior threads without overwriting operator edits", () => {
    const previous = plan(
      [
        stage("01", {
          assignment: assignment("worker-a"),
          executionStatus: "completed",
          acceptance: [criterion("01.1", "The work completes.", "passed", "worker proof")]
        })
      ],
      [
        annotation("thread-1", {
          status: "open",
          messages: [
            {
              id: "message-user",
              body: "Keep the operator's edited requirement.",
              authorKind: "user",
              authorId: "operator",
              createdAt: "2026-07-31T08:00:00.000Z",
              mentionedParticipantIds: ["worker-a"],
              deliveryState: "sent"
            }
          ]
        })
      ]
    )
    const replacement = plan(
      [
        stage("01", {
          assignment: assignment("replacement-worker"),
          acceptance: [criterion("01.1", "The work completes.")]
        })
      ],
      [
        annotation("thread-1", {
          status: "resolved",
          messages: [
            {
              id: "message-user",
              body: "Agent's stale copy of the user message.",
              authorKind: "user",
              authorId: "operator",
              createdAt: "2026-07-31T08:00:00.000Z",
              mentionedParticipantIds: [],
              deliveryState: "sent"
            },
            {
              id: "message-agent",
              body: "I retained it.",
              authorKind: "agent",
              authorId: "worker-a",
              createdAt: "2026-07-31T08:01:00.000Z",
              mentionedParticipantIds: ["operator"],
              deliveryState: "sent"
            }
          ]
        })
      ]
    )

    const result = reconcilePlanAmendment(previous, replacement)

    expect(result.valid).toBe(true)
    if (!result.valid) return
    expect(result.plan.stages[0]).toMatchObject({
      assignment: { agentId: "worker-a" },
      executionStatus: "completed",
      acceptance: [{ id: "01.1", status: "passed", evidence: "worker proof" }]
    })
    expect(result.plan.annotations[0]).toMatchObject({
      id: "thread-1",
      status: "open",
      messages: [
        {
          id: "message-user",
          body: "Keep the operator's edited requirement.",
          mentionedParticipantIds: ["worker-a"]
        },
        {
          id: "message-agent",
          body: "I retained it.",
          authorKind: "agent",
          authorId: "worker-a",
          mentionedParticipantIds: ["operator"]
        }
      ]
    })
  })
})

describe("planStageSemanticFingerprint", () => {
  it("ignores assignment and execution-status changes", () => {
    const compact = stage("01", {
      title: "Stable",
      complexity: "medium",
      assignment: assignment("worker-a"),
      executionStatus: "completed",
      approach: ["Run tests"],
      acceptance: [criterion("01.1", "Tests pass.", "passed", "green")]
    })
    const rerouted = stage("01", {
      title: "Stable",
      complexity: "medium",
      assignment: assignment("worker-b"),
      executionStatus: "queued",
      approach: ["Run tests"],
      acceptance: [criterion("01.1", "Tests pass.")]
    })

    expect(planStageSemanticFingerprint(rerouted)).toBe(planStageSemanticFingerprint(compact))

    const reconciled = reconcilePlanAmendment(plan([compact]), plan([rerouted]))
    expect(reconciled.valid).toBe(true)
    if (!reconciled.valid) return
    expect(reconciled.changedStageIds).toEqual([])
    expect(reconciled.plan.stages[0]).toMatchObject({
      executionStatus: "completed",
      assignment: { agentId: "worker-a" },
      acceptance: [{ id: "01.1", status: "passed", evidence: "green" }]
    })
  })

  it("is unaffected by plan-level annotations", () => {
    const base = stage("01", {
      title: "Stable",
      complexity: "medium",
      assignment: assignment("worker-a"),
      executionStatus: "completed",
      notes: [{ kind: "prose", id: "n1", text: "Implement the stable behavior." }],
      acceptance: [criterion("01.1", "Tests pass.", "passed", "green")]
    })
    const previous = plan([base])
    const replacement = plan(
      [stage("01", { ...base, assignment: assignment("worker-b"), executionStatus: "queued" })],
      [annotation("worker-note", { author: "agent", body: "Worker was interrupted." })]
    )

    const reconciled = reconcilePlanAmendment(previous, replacement)

    expect(reconciled.valid).toBe(true)
    if (!reconciled.valid) return
    expect(reconciled.changedStageIds).toEqual([])
    expect(reconciled.plan.stages[0]).toMatchObject({
      executionStatus: "completed",
      acceptance: [{ id: "01.1", status: "passed", evidence: "green" }]
    })
  })

  it("changes when a declared file's change kind changes", () => {
    const before = stage("01", { files: [{ path: "src/a.ts", change: "M" }] })
    const after = stage("01", { files: [{ path: "src/a.ts", change: "D" }] })

    expect(planStageSemanticFingerprint(after)).not.toBe(planStageSemanticFingerprint(before))
  })
})
