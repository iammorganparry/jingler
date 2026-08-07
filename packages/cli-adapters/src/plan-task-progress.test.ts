import {
  type PlanDocument,
  type PlanPrdStage
} from "@jingler/core"
import { describe, expect, it } from "vitest"
import {
  planTaskProgressFingerprint,
  planTaskProgressFromText,
  resumeCanonicalPlanPrompt,
  stripPlanTaskProgressProtocol
} from "./plan-task-progress.js"

const stage: PlanPrdStage = {
  id: "01",
  title: "Persist progress",
  intent: "Keep completed work across restarts.",
  approach: [],
  tasks: [
    { id: "01.task.1", text: "Write the checkpoint", status: "completed" },
    { id: "01.task.2", text: "Resume the plan", status: "in-progress" }
  ],
  files: [],
  diagrams: [],
  notes: [],
  acceptance: [
    {
      id: "01.1",
      text: "Restart preserves progress.",
      testReferences: [],
      status: "pending",
      evidence: null
    }
  ],
  dependencies: [],
  executionStatus: "running"
}

const document: PlanDocument = {
  id: "plan-1",
  sessionId: "session-1",
  producingChatId: "chat-1",
  revision: 4,
  status: "executing",
  plan: {
    title: "PRD: Durable progress",
    sections: [],
    stages: [stage],
    annotations: []
  },
  updatedAt: "2026-08-07T00:00:00.000Z",
  updatedBy: "agent"
}

describe("plan task progress protocol", () => {
  it("embeds exact completed and in-progress checkpoints in a restart prompt", () => {
    const prompt = resumeCanonicalPlanPrompt(document)
    expect(prompt).toContain(
      `Stage 01 fingerprint=${planTaskProgressFingerprint(stage)} execution=running`
    )
    expect(prompt).toContain("1. [completed] 01.task.1 — Write the checkpoint")
    expect(prompt).toContain("2. [in-progress] 01.task.2 — Resume the plan")
    expect(prompt).toContain("Do not repeat tasks already marked completed")
  })

  it("parses complete markers from accumulated streamed output", () => {
    expect(
      planTaskProgressFromText(
        "Working\nPLAN_TASK stage=01 fingerprint=abc task=01.task.2 status=completed\nDone"
      )
    ).toEqual([
      {
        stageId: "01",
        stageFingerprint: "abc",
        taskId: "01.task.2",
        status: "completed"
      }
    ])
  })

  it("removes complete and partial task protocol lines from visible prose", () => {
    expect(
      stripPlanTaskProgressProtocol(
        "Working\nPLAN_TASK stage=01 fingerprint=abc task=01.task.2 status=completed\nPLAN_TAS"
      )
    ).toBe("Working")
  })
})
