import { Either, Schema } from "effect"
import { describe, expect, it } from "vitest"
import {
  defaultPlan,
  PlanAcceptance,
  PlanCommentMessage,
  PlanDocument,
  PlanPrdStage,
  PlanTask,
  PlanTemplateConfig,
  PlanTestReference,
  planDocumentToPlan
} from "./plan-document.js"

const structuredStage = {
  id: "02",
  title: "Execute workers",
  intent: "Run independent work concurrently.",
  approach: ["Read the runtime", "Dispatch each worker"],
  files: [{ path: "src/runtime.ts", change: "M" }],
  diagrams: [],
  notes: [{ kind: "prose", id: "n1", text: "Work happens here." }],
  acceptance: [],
  dependencies: ["01"],
  complexity: "high",
  assignment: {
    agentId: "worker-a",
    cli: "codex",
    model: "gpt-5",
    reason: "The stage spans concurrency and persistence."
  },
  executionStatus: "running"
}

describe("plan document schemas", () => {
  it("decodes progressable tasks and named test references", () => {
    const decoded = Schema.decodeUnknownEither(PlanPrdStage)({
      ...structuredStage,
      tasks: [
        { id: "02.task.1", text: "Dispatch independent workers", status: "in-progress" },
        { id: "02.task.2", text: "Collect verification evidence", status: "blocked" }
      ],
      acceptance: [
        {
          id: "02.1",
          text: "Independent workers complete.",
          testReferences: [
            {
              path: "packages/core/src/plan-document.test.ts",
              cases: ["decodes progressable tasks and named test references"]
            }
          ],
          status: "pending",
          evidence: null
        }
      ],
      walkthrough: [
        { kind: "prose", id: "why", text: "Keep the worker boundary explicit." },
        { kind: "code", id: "example", language: "ts", code: "await dispatch(stage)" }
      ]
    })

    expect(Either.isRight(decoded)).toBe(true)
    if (Either.isLeft(decoded)) return
    expect(decoded.right.tasks).toEqual([
      { id: "02.task.1", text: "Dispatch independent workers", status: "in-progress" },
      { id: "02.task.2", text: "Collect verification evidence", status: "blocked" }
    ])
    expect(decoded.right.acceptance[0]?.testReferences).toEqual([
      {
        path: "packages/core/src/plan-document.test.ts",
        cases: ["decodes progressable tasks and named test references"]
      }
    ])
    expect(decoded.right.walkthrough).toHaveLength(2)
    expect(
      Either.isRight(
        Schema.decodeUnknownEither(PlanTask)({ id: "task", text: "Do work", status: "completed" })
      )
    ).toBe(true)
    expect(
      Either.isRight(
        Schema.decodeUnknownEither(PlanTestReference)({ path: "src/example.test.ts", cases: ["works"] })
      )
    ).toBe(true)
  })

  it("keeps legacy plans without tasks or test references readable", () => {
    const decoded = Schema.decodeUnknownEither(PlanDocument)({
      id: "legacy-plan",
      sessionId: "session-1",
      producingChatId: "chat-1",
      revision: 3,
      status: "proposed",
      plan: {
        title: "PRD: Legacy plan",
        sections: [],
        stages: [
          {
            ...structuredStage,
            acceptance: [
              {
                id: "02.1",
                text: "The old criterion remains readable.",
                status: "passed",
                evidence: "legacy evidence"
              }
            ]
          }
        ],
        annotations: []
      },
      updatedAt: "2026-07-28T12:00:00.000Z",
      updatedBy: "agent"
    })

    expect(Either.isRight(decoded)).toBe(true)
    if (Either.isLeft(decoded)) return
    expect(decoded.right.plan.stages[0]?.tasks).toEqual([])
    expect(decoded.right.plan.stages[0]?.walkthrough).toBeUndefined()
    expect(decoded.right.plan.stages[0]?.acceptance[0]?.testReferences).toEqual([])
  })

  it("builds a blank default plan", () => {
    expect(defaultPlan()).toEqual({ title: "Plan", sections: [], stages: [], annotations: [] })
    expect(defaultPlan("PRD: Custom").title).toBe("PRD: Custom")
  })

  it("accepts evidence-bearing criteria", () => {
    const decoded = Schema.decodeUnknownEither(PlanAcceptance)({
      id: "01.1",
      text: "The saved plan survives restart.",
      status: "passed",
      evidence: "plan-store.test.ts"
    })
    expect(Either.isRight(decoded)).toBe(true)
  })

  it("rejects unknown acceptance states", () => {
    const decoded = Schema.decodeUnknownEither(PlanAcceptance)({
      id: "01.1",
      text: "No silent overwrite.",
      status: "maybe",
      evidence: null
    })
    expect(Either.isLeft(decoded)).toBe(true)
  })

  it("decodes durable comment messages with identity, mentions, and delivery", () => {
    const decoded = Schema.decodeUnknownEither(PlanCommentMessage)({
      id: "message-1",
      body: "Please check the retry behavior.",
      authorKind: "user",
      authorId: "operator-1",
      createdAt: "2026-07-31T10:00:00.000Z",
      mentionedParticipantIds: ["worker-runtime"],
      deliveryState: "pending",
      mentionDeliveries: [
        {
          participantId: "worker-runtime",
          status: "dispatching",
          dispatchId: "message-1:worker-runtime",
          detail: null,
          retryable: false
        }
      ]
    })

    expect(Either.isRight(decoded)).toBe(true)
    expect(
      Either.isLeft(
        Schema.decodeUnknownEither(PlanCommentMessage)({
          id: "message-2",
          body: "Unknown state",
          authorKind: "agent",
          authorId: "orchestrator",
          createdAt: "2026-07-31T10:01:00.000Z",
          mentionedParticipantIds: [],
          deliveryState: "maybe"
        })
      )
    ).toBe(true)
  })

  it("decodes a structured stage with typed blocks, files, and execution metadata", () => {
    expect(Either.isRight(Schema.decodeUnknownEither(PlanPrdStage)(structuredStage))).toBe(true)

    // Required block arrays are structural — omitting them is a typed error the
    // reformat loop surfaces, not a silent legacy fallback.
    const { files: _files, ...missingFiles } = structuredStage
    expect(Either.isLeft(Schema.decodeUnknownEither(PlanPrdStage)(missingFiles))).toBe(true)
  })

  it("carries the structured plan at the RPC boundary", () => {
    const decoded = Schema.decodeUnknownEither(PlanDocument)({
      id: "p1",
      sessionId: "s1",
      producingChatId: "c1",
      revision: 1,
      status: "proposed",
      plan: { title: "PRD", sections: [], stages: [], annotations: [] },
      updatedAt: "2026-07-28T12:00:00.000Z",
      updatedBy: "agent"
    })
    expect(Either.isRight(decoded)).toBe(true)
    expect(
      Either.isRight(
        Schema.decodeUnknownEither(PlanTemplateConfig)({ source: "" })
      )
    ).toBe(true)
  })

  it("uses the PRD outcome as the compatibility-card summary", () => {
    const document = {
      id: "p1",
      sessionId: "s1",
      producingChatId: "c1",
      revision: 1,
      status: "proposed" as const,
      plan: {
        title: "PRD: Canonical interactive planning",
        sections: [],
        stages: [],
        annotations: []
      },
      updatedAt: "2026-07-28T12:00:00.000Z",
      updatedBy: "agent" as const
    }

    expect(planDocumentToPlan(document).summary).toBe("Canonical interactive planning")
  })
})
