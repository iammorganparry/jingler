import type { PlanDocument } from "@jingler/core"
import { waitFor } from "xstate"
import { afterEach, describe, expect, it, vi } from "vitest"
import {
  flushPlanDocumentActor,
  getPlanDocumentActor,
  stopPlanDocument
} from "./plan-document-registry.js"

const source = (label: string): string => `<h1>PRD: ${label}</h1>`
const document = (sessionId: string, revision = 1, label = "Initial"): PlanDocument => ({
  id: `plan-${sessionId}`,
  sessionId,
  producingChatId: `chat-${sessionId}`,
  revision,
  status: "proposed",
  source: source(label),
  projection: { title: `PRD: ${label}`, sections: [], stages: [], annotations: [] },
  updatedAt: `2026-07-31T00:00:0${revision}.000Z`,
  updatedBy: revision === 1 ? "agent" : "user"
})

const deferred = <A>() => {
  let resolve!: (value: A) => void
  const promise = new Promise<A>((yes) => {
    resolve = yes
  })
  return { promise, resolve }
}

const sessions = new Set<string>()
afterEach(() => {
  for (const sessionId of sessions) stopPlanDocument(sessionId)
  sessions.clear()
  vi.useRealTimers()
})

describe("plan document registry", () => {
  it("keeps a pending debounced save alive across view remounts", async () => {
    vi.useFakeTimers()
    const sessionId = "registry-remount"
    sessions.add(sessionId)
    const save = vi.fn(async ({ source: nextSource }: { source: string }) => ({
      ...document(sessionId, 2, "Edited"),
      source: nextSource
    }))
    const input = {
      sessionId,
      load: async () => document(sessionId),
      save
    }
    const firstView = getPlanDocumentActor(sessionId, input)
    await vi.advanceTimersByTimeAsync(0)
    await waitFor(firstView, (snapshot) => snapshot.matches("clean"))

    firstView.send({ type: "EDIT", source: source("Edited") })
    const remountedView = getPlanDocumentActor(sessionId, input)

    expect(remountedView).toBe(firstView)
    expect(remountedView.getSnapshot().context.draft).toBe(source("Edited"))
    await vi.advanceTimersByTimeAsync(1_000)
    expect(save).toHaveBeenCalledOnce()
  })

  it("flushes the newest draft typed while an earlier save is in flight", async () => {
    const sessionId = "registry-flush"
    sessions.add(sessionId)
    const firstSave = deferred<PlanDocument>()
    let calls = 0
    const save = vi.fn(async ({ source: nextSource }: { source: string }) => {
      calls += 1
      return calls === 1
        ? firstSave.promise
        : { ...document(sessionId, 3, "Second"), source: nextSource }
    })
    const actor = getPlanDocumentActor(sessionId, {
      sessionId,
      load: async () => document(sessionId),
      save
    })
    await waitFor(actor, (snapshot) => snapshot.matches("clean"))

    actor.send({ type: "EDIT", source: source("First") })
    const flushed = flushPlanDocumentActor(actor)
    await waitFor(actor, (snapshot) => snapshot.matches("saving"))
    actor.send({ type: "EDIT", source: source("Second") })
    firstSave.resolve(document(sessionId, 2, "First"))
    await flushed

    expect(save).toHaveBeenCalledTimes(2)
    expect(save).toHaveBeenLastCalledWith({
      document: document(sessionId, 2, "First"),
      source: source("Second")
    })
    expect(actor.getSnapshot().matches("clean")).toBe(true)
  })
})
