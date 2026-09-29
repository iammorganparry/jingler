// @vitest-environment jsdom
import type { PlanAnnotation } from "@jingler/core"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { loadPlanComments, planCommentStorageKey, savePlanComments } from "./plan-comment-store.js"

const thread: PlanAnnotation = {
  id: "thread-1",
  stageId: "stage-1",
  body: "Keep this behavior.",
  author: "user",
  createdAt: "2026-09-29T00:00:00.000Z",
  status: "open",
  messages: [{
    id: "message-1",
    body: "Keep this behavior.",
    authorKind: "user",
    authorId: "operator",
    createdAt: "2026-09-29T00:00:00.000Z",
    mentionedParticipantIds: [],
    deliveryState: "sent"
  }]
}

beforeEach(() => localStorage.clear())

describe("plan comment storage", () => {
  it("persists typed threads by plan id", () => {
    savePlanComments("plan-a", [thread])
    expect(loadPlanComments("plan-a")).toEqual([thread])
    expect(loadPlanComments("plan-b")).toEqual([])
  })

  it("drops invalid data and survives storage failures", () => {
    localStorage.setItem(planCommentStorageKey("bad"), JSON.stringify([thread, { id: 1 }]))
    expect(loadPlanComments("bad")).toEqual([thread])
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("quota") })
    expect(() => savePlanComments("plan-a", [thread])).not.toThrow()
  })
})
