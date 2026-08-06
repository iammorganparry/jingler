import { createActor } from "xstate"
import { describe, expect, it, vi } from "vitest"
import type { PublishCheckpoint } from "@jingler/core"
import { createRendererPublishMachine } from "./publish-machine.js"

const checkpoint = (step: PublishCheckpoint["step"], extra: Partial<PublishCheckpoint> = {}): PublishCheckpoint => ({
  step,
  completed: [],
  updatedAt: new Date().toISOString(),
  ...extra
})

describe("renderer publish machine", () => {
  it("maps streamed checkpoints and reports completion", () => {
    let listener: ((value: PublishCheckpoint) => void) | null = null
    const onComplete = vi.fn()
    const actor = createActor(createRendererPublishMachine(undefined, {
      subscribe: (next) => { listener = next; return () => { listener = null } },
      onComplete
    })).start()

    actor.send({ type: "PUBLISH" })
    listener!(checkpoint("pushing", { branch: "feat/publish" }))
    expect(actor.getSnapshot().matches("publishing")).toBe(true)
    expect(actor.getSnapshot().context.checkpoint?.step).toBe("pushing")

    listener!(checkpoint("complete", { prNumber: 42 }))
    expect(actor.getSnapshot().matches("complete")).toBe(true)
    expect(onComplete).toHaveBeenCalledWith(expect.objectContaining({ prNumber: 42 }))
  })

  it("retries a failed publication through a new subscription", () => {
    let subscriptions = 0
    let listener: ((value: PublishCheckpoint) => void) | null = null
    const actor = createActor(createRendererPublishMachine(undefined, {
      subscribe: (next) => { subscriptions += 1; listener = next; return () => undefined },
      onComplete: () => undefined
    })).start()
    actor.send({ type: "PUBLISH" })
    listener!(checkpoint("failed", { error: "push failed", resumeFrom: "pushing" }))
    actor.send({ type: "RETRY" })
    expect(actor.getSnapshot().matches("publishing")).toBe(true)
    expect(subscriptions).toBe(2)
  })
})
