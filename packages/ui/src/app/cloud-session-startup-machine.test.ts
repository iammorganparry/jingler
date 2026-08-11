import { createActor } from "xstate"
import { describe, expect, it } from "vitest"
import { cloudSessionStartupMachine } from "./cloud-session-startup-machine.js"

describe("cloudSessionStartupMachine", () => {
  it("keeps a navigable pending session while startup progresses", () => {
    const actor = createActor(cloudSessionStartupMachine).start()

    actor.send({ type: "START", id: "pending-cloud", title: "Cloud task", repo: "jingler" })
    actor.send({ type: "PROGRESS", phase: "starting-sandbox" })

    expect(actor.getSnapshot().context.pending).toMatchObject({
      id: "pending-cloud",
      phase: "starting-sandbox",
      error: null
    })
    expect(actor.getSnapshot().matches("running")).toBe(true)
  })

  it("retains failed startup details until the operator dismisses them", () => {
    const actor = createActor(cloudSessionStartupMachine).start()
    actor.send({ type: "START", id: "pending-cloud", title: "Cloud task", repo: "jingler" })
    actor.send({ type: "FAILED", error: new Error("Cloud access timed out") })

    expect(actor.getSnapshot().context.pending?.error).toBe("Cloud access timed out")
    actor.send({ type: "DISMISS" })
    expect(actor.getSnapshot().context.pending).toBeNull()
  })

  it("removes the placeholder once the real session exists", () => {
    const actor = createActor(cloudSessionStartupMachine).start()
    actor.send({ type: "START", id: "pending-cloud", title: "Cloud task", repo: "jingler" })
    actor.send({ type: "COMPLETED" })

    expect(actor.getSnapshot().context.pending).toBeNull()
    expect(actor.getSnapshot().matches("idle")).toBe(true)
  })
})
