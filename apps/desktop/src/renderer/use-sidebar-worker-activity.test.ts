import type { WorkerActivity, WorkerState } from "@jingler/core"
import { describe, expect, it } from "vitest"
import {
  foldSidebarWorkerActivity,
  orchestrationSessionActivity
} from "./sidebar-worker-activity.js"

const state = (
  status: WorkerState["status"],
  agentId = "agent-01",
  attempt = 1
): WorkerState => ({
  worker: {
    sessionId: "session-1",
    planId: "plan-1",
    producingChatId: "chat-1",
    agentId,
    stageIds: ["01"],
    harness: "codex",
    model: "gpt-5.6-sol",
    attempt
  },
  status,
  message: null
})

describe("sidebar worker activity", () => {
  it("keeps a session delegating from a session-wide worker reset", () => {
    const activity: WorkerActivity = {
      _tag: "Reset",
      sessionId: "session-1",
      planId: "plan-1",
      producingChatId: "chat-1",
      mode: "replace",
      workers: [state("running")]
    }
    const snapshot = foldSidebarWorkerActivity({}, activity)
    expect(orchestrationSessionActivity(Object.values(snapshot))).toEqual({
      kind: "delegating",
      verb: "Delegating",
      target: "agent-01"
    })
  })

  it("does not resurrect a completed worker from a late harness event", () => {
    const completed = foldSidebarWorkerActivity({}, {
      _tag: "State",
      ...state("completed")
    })
    const afterLateEvent = foldSidebarWorkerActivity(completed, {
      _tag: "HarnessEvent",
      worker: state("running").worker,
      stageId: "01",
      event: { _tag: "Assistant", text: "late" }
    })
    expect(orchestrationSessionActivity(Object.values(afterLateEvent))).toBeNull()
  })

  it("replaces an old plan snapshot so stale workers cannot keep a session active", () => {
    const active = foldSidebarWorkerActivity({}, {
      _tag: "Reset",
      sessionId: "session-1",
      planId: "plan-1",
      producingChatId: "chat-1",
      mode: "replace",
      workers: [state("running")]
    })
    const replaced = foldSidebarWorkerActivity(active, {
      _tag: "Reset",
      sessionId: "session-1",
      planId: "plan-2",
      producingChatId: "chat-2",
      mode: "replace",
      workers: [state("completed", "agent-02")]
    })
    expect(Object.keys(replaced)).toEqual(["agent-02"])
    expect(orchestrationSessionActivity(Object.values(replaced))).toBeNull()
  })
})
