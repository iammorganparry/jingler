import type { PlanDocument } from "@jingler/core"
import { createActor, waitFor } from "xstate"
import { describe, expect, it } from "vitest"
import { planDocumentMachine } from "./plan-document-machine.js"

const source = (label: string) => `<h1>PRD: ${label}</h1>`

const document = (revision = 1, label = "Initial"): PlanDocument => ({
  id: "plan-1",
  sessionId: "s1",
  producingChatId: "c1",
  revision,
  status: "proposed",
  source: source(label),
  projection: {
    title: `PRD: ${label}`,
    sections: [],
    stages: [],
    annotations: []
  },
  updatedAt: `2026-07-28T00:00:0${revision}.000Z`,
  updatedBy: revision === 1 ? "agent" : "user"
})

const start = (
  load: () => Promise<PlanDocument | null>,
  subscribe?: (listener: (document: PlanDocument) => void) => () => void
) =>
  createActor(planDocumentMachine, {
    input: { sessionId: "s1", load, subscribe }
  }).start()

describe("planDocumentMachine", () => {
  it("loads the canonical document into a clean, read-only state", async () => {
    const actor = start(async () => document(2))
    await waitFor(actor, (snapshot) => snapshot.matches("clean"))
    expect(actor.getSnapshot().context.document).toStrictEqual(document(2))
    expect(actor.getSnapshot().context.draft).toBe(source("Initial"))
    actor.stop()
  })

  it("adopts a broadcast revision while clean (remote-wins)", async () => {
    const watched: { listener?: (document: PlanDocument) => void } = {}
    const actor = start(
      async () => document(2),
      (next) => {
        watched.listener = next
        return () => {
          delete watched.listener
        }
      }
    )
    await waitFor(actor, (snapshot) => snapshot.matches("clean"))
    watched.listener?.(document(4, "Shared"))
    await waitFor(actor, (snapshot) => snapshot.context.document?.revision === 4)
    expect(actor.getSnapshot().context.draft).toBe(source("Shared"))
    actor.stop()
  })

  it("ignores a stale broadcast revision", async () => {
    const watched: { listener?: (document: PlanDocument) => void } = {}
    const actor = start(
      async () => document(3, "Current"),
      (next) => {
        watched.listener = next
        return () => {
          delete watched.listener
        }
      }
    )
    await waitFor(actor, (snapshot) => snapshot.matches("clean"))
    watched.listener?.(document(2, "Older"))
    expect(actor.getSnapshot().context.document?.revision).toBe(3)
    actor.stop()
  })

  it("surfaces a load failure and retries it", async () => {
    let attempt = 0
    const actor = start(async () => {
      attempt += 1
      if (attempt === 1) throw new Error("disk unavailable")
      return document(2)
    })
    await waitFor(actor, (snapshot) => snapshot.matches("error"))
    expect(actor.getSnapshot().context.error).toContain("disk unavailable")

    actor.send({ type: "RETRY" })
    await waitFor(actor, (snapshot) => snapshot.matches("clean"))
    expect(actor.getSnapshot().context.document?.revision).toBe(2)
    actor.stop()
  })
})
