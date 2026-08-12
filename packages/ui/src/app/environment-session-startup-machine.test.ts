import { createActor } from "xstate"
import { describe, expect, it } from "vitest"
import { environmentSessionStartupMachine } from "./environment-session-startup-machine.js"

const startOwned = {
  type: "START" as const,
  id: "pending-remote",
  title: "Remote task",
  repo: "jingler",
  environmentId: "device-buildbox",
  environmentName: "buildbox",
  environmentKind: "owned" as const
}

describe("environmentSessionStartupMachine", () => {
  it("keeps an owned-device session navigable while host preparation progresses", () => {
    const actor = createActor(environmentSessionStartupMachine).start()

    actor.send(startOwned)
    actor.send({ type: "PROGRESS", phase: "resolving-repository" })

    expect(actor.getSnapshot().context.pending).toMatchObject({
      id: "pending-remote",
      environmentName: "buildbox",
      environmentKind: "owned",
      phase: "resolving-repository",
      error: null
    })
    expect(actor.getSnapshot().matches("running")).toBe(true)
  })

  it("keeps a Cloud session navigable while sandbox startup progresses", () => {
    const actor = createActor(environmentSessionStartupMachine).start()
    actor.send({
      ...startOwned,
      environmentId: "cloud",
      environmentName: "Cloud",
      environmentKind: "managed"
    })
    actor.send({ type: "PROGRESS", phase: "starting-sandbox" })

    expect(actor.getSnapshot().context.pending).toMatchObject({
      environmentKind: "managed",
      phase: "starting-sandbox"
    })
  })

  it("retains failed startup details until the operator dismisses them", () => {
    const actor = createActor(environmentSessionStartupMachine).start()
    actor.send(startOwned)
    actor.send({ type: "FAILED", error: new Error("Device access timed out") })

    expect(actor.getSnapshot().context.pending?.error).toBe("Device access timed out")
    actor.send({ type: "DISMISS" })
    expect(actor.getSnapshot().context.pending).toBeNull()
  })

  it("removes the placeholder once the real session exists", () => {
    const actor = createActor(environmentSessionStartupMachine).start()
    actor.send(startOwned)
    actor.send({ type: "COMPLETED" })

    expect(actor.getSnapshot().context.pending).toBeNull()
    expect(actor.getSnapshot().matches("idle")).toBe(true)
  })
})
