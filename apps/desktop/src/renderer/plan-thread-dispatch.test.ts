import type { PlanCommentMessage } from "@jingler/core"
import { describe, expect, it } from "vitest"
import {
  runWithDirectPlanThreadDispatch,
  shouldRecoverPendingPlanMessage
} from "./plan-thread-dispatch.js"

const pendingMessage: PlanCommentMessage = {
  id: "message-1",
  body: "@worker please review",
  authorKind: "user",
  authorId: "operator",
  createdAt: "2026-07-31T12:00:00.000Z",
  mentionedParticipantIds: ["worker-1"],
  deliveryState: "pending"
}

describe("shouldRecoverPendingPlanMessage", () => {
  it("does not race a direct reply dispatch that is already routing the thread", async () => {
    let release!: () => void
    const routing = runWithDirectPlanThreadDispatch(
      "plan-1",
      "annotation-1",
      () => new Promise<void>((resolve) => {
        release = resolve
      })
    )
    expect(
      shouldRecoverPendingPlanMessage({
        planId: "plan-1",
        annotationId: "annotation-1",
        message: pendingMessage,
        recoveredMessageDispatches: new Set()
      })
    ).toBe(false)
    release()
    await routing
  })

  it("recovers an observed pending mention when no dispatcher owns it", () => {
    expect(
      shouldRecoverPendingPlanMessage({
        planId: "plan-1",
        annotationId: "annotation-1",
        message: pendingMessage,
        recoveredMessageDispatches: new Set()
      })
    ).toBe(true)
  })
})
