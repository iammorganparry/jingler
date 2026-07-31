import type { PlanDocument } from "@jingler/core"
import { createActor, waitFor } from "xstate"
import { describe, expect, it, vi } from "vitest"
import { planDocumentMachine } from "./plan-document-machine.js"

const source = (label: string) => `# PRD: ${label}

<Stage id="01" title="Stage">
<Acceptance id="01.1" status="pending">It works.</Acceptance>
</Stage>
`

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
    stages: [
      {
        id: "01",
        title: "Stage",
        intent: "",
        markdown: "",
        acceptance: [{ id: "01.1", text: "It works.", status: "pending", evidence: null }]
      }
    ],
    annotations: []
  },
  updatedAt: `2026-07-28T00:00:0${revision}.000Z`,
  updatedBy: revision === 1 ? "agent" : "user"
})

const deferred = <A>() => {
  let resolve!: (value: A) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<A>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}

const start = (
  save: (input: { document: PlanDocument; source: string }) => Promise<PlanDocument>,
  subscribe?: (listener: (document: PlanDocument) => void) => () => void
) =>
  createActor(planDocumentMachine, {
    input: {
      sessionId: "s1",
      load: async () => document(),
      save,
      subscribe
    }
  }).start()

describe("planDocumentMachine", () => {
  it("persists only the latest draft after one second of editor inactivity", async () => {
    vi.useFakeTimers()
    const save = vi.fn(async ({ source: nextSource }) => ({
      ...document(2, "Latest complete draft"),
      source: nextSource
    }))
    const actor = start(save)

    try {
      await vi.advanceTimersByTimeAsync(0)
      await waitFor(actor, (snapshot) => snapshot.matches("clean"))

      actor.send({ type: "EDIT", source: source("First partial draft") })
      await vi.advanceTimersByTimeAsync(400)
      actor.send({ type: "EDIT", source: source("Second partial draft") })
      await vi.advanceTimersByTimeAsync(400)
      actor.send({ type: "EDIT", source: source("Latest complete draft") })

      await vi.advanceTimersByTimeAsync(999)
      expect(save).not.toHaveBeenCalled()

      await vi.advanceTimersByTimeAsync(1)
      expect(save).toHaveBeenCalledOnce()
      expect(save).toHaveBeenCalledWith({
        document: document(),
        source: source("Latest complete draft")
      })
    } finally {
      actor.stop()
      vi.useRealTimers()
    }
  })

  it("restarts the trailing debounce while the editor remains active", async () => {
    vi.useFakeTimers()
    const save = vi.fn(async ({ source: nextSource }) => ({
      ...document(2, "Third edit"),
      source: nextSource
    }))
    const actor = start(save)

    try {
      await vi.advanceTimersByTimeAsync(0)
      await waitFor(actor, (snapshot) => snapshot.matches("clean"))

      actor.send({ type: "EDIT", source: source("First edit") })
      await vi.advanceTimersByTimeAsync(750)
      expect(save).not.toHaveBeenCalled()
      actor.send({ type: "EDIT", source: source("Second edit") })
      await vi.advanceTimersByTimeAsync(750)
      expect(save).not.toHaveBeenCalled()

      actor.send({ type: "EDIT", source: source("Third edit") })

      await vi.advanceTimersByTimeAsync(999)
      expect(save).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(1)
      expect(save).toHaveBeenCalledOnce()
      expect(save).toHaveBeenLastCalledWith({
        document: document(),
        source: source("Third edit")
      })
    } finally {
      actor.stop()
      vi.useRealTimers()
    }
  })

  it("flushes the current draft immediately without leaving its debounce behind", async () => {
    vi.useFakeTimers()
    const save = vi.fn(async ({ source: nextSource }) => ({
      ...document(2, "Saved now"),
      source: nextSource
    }))
    const actor = start(save)

    try {
      await vi.advanceTimersByTimeAsync(0)
      await waitFor(actor, (snapshot) => snapshot.matches("clean"))

      actor.send({ type: "EDIT", source: source("Saved now") })
      actor.send({ type: "SAVE_NOW" })
      await vi.advanceTimersByTimeAsync(0)

      expect(save).toHaveBeenCalledOnce()
      expect(save).toHaveBeenCalledWith({
        document: document(),
        source: source("Saved now")
      })
      await vi.advanceTimersByTimeAsync(2_000)
      expect(save).toHaveBeenCalledOnce()
    } finally {
      actor.stop()
      vi.useRealTimers()
    }
  })

  it("debounces a newer edit after the current save finishes", async () => {
    vi.useFakeTimers()
    const gate = deferred<PlanDocument>()
    let saveNumber = 0
    const save = vi.fn(async ({ source: nextSource }) => {
      saveNumber += 1
      if (saveNumber === 1) return gate.promise
      return { ...document(3, "Second edit"), source: nextSource }
    })
    const actor = start(save)

    try {
      await vi.advanceTimersByTimeAsync(0)
      await waitFor(actor, (snapshot) => snapshot.matches("clean"))

      actor.send({ type: "EDIT", source: source("First edit") })
      actor.send({ type: "SAVE_NOW" })
      await waitFor(actor, (snapshot) => snapshot.matches("saving"))
      actor.send({ type: "EDIT", source: source("Second edit") })
      gate.resolve(document(2, "First edit"))
      await vi.advanceTimersByTimeAsync(0)

      expect(actor.getSnapshot().matches("editing")).toBe(true)
      await vi.advanceTimersByTimeAsync(999)
      expect(save).toHaveBeenCalledOnce()
      await vi.advanceTimersByTimeAsync(1)
      expect(save).toHaveBeenCalledTimes(2)
      expect(save).toHaveBeenLastCalledWith({
        document: document(2, "First edit"),
        source: source("Second edit")
      })
    } finally {
      actor.stop()
      vi.useRealTimers()
    }
  })

  it("cancels a pending autosave when a remote revision wins or the actor stops", async () => {
    vi.useFakeTimers()
    const save = vi.fn(async () => document(2))
    const actor = start(save)

    try {
      await vi.advanceTimersByTimeAsync(0)
      await waitFor(actor, (snapshot) => snapshot.matches("clean"))

      actor.send({ type: "EDIT", source: source("Local draft") })
      actor.send({ type: "REMOTE", document: document(2, "Remote") })
      expect(actor.getSnapshot().matches("conflict")).toBe(true)
      await vi.advanceTimersByTimeAsync(2_000)
      expect(save).not.toHaveBeenCalled()

      const stoppedActor = start(save)
      await vi.advanceTimersByTimeAsync(0)
      await waitFor(stoppedActor, (snapshot) => snapshot.matches("clean"))
      stoppedActor.send({ type: "EDIT", source: source("Stopped draft") })
      stoppedActor.stop()
      await vi.advanceTimersByTimeAsync(2_000)
      expect(save).not.toHaveBeenCalled()
    } finally {
      actor.stop()
      vi.useRealTimers()
    }
  })

  it("loads the canonical document into a clean editor", async () => {
    const actor = start(async () => document(2))
    await waitFor(actor, (snapshot) => snapshot.matches("clean"))
    expect(actor.getSnapshot().context.document).toStrictEqual(document())
    expect(actor.getSnapshot().context.draft).toBe(source("Initial"))
    actor.stop()
  })

  it("moves editing → saving → clean and adopts the saved revision", async () => {
    const save = vi.fn(async ({ source: nextSource }) => ({
      ...document(2, "Edited"),
      source: nextSource
    }))
    const actor = start(save)
    await waitFor(actor, (snapshot) => snapshot.matches("clean"))

    actor.send({ type: "EDIT", source: source("Edited") })
    expect(actor.getSnapshot().matches("editing")).toBe(true)
    actor.send({ type: "SAVE_NOW" })
    await waitFor(actor, (snapshot) => snapshot.matches("clean"))

    expect(save).toHaveBeenCalledWith({
      document: document(),
      source: source("Edited")
    })
    expect(actor.getSnapshot().context.document?.revision).toBe(2)
    actor.stop()
  })

  it("retains a newer local edit when it arrives during an in-flight save", async () => {
    const gate = deferred<PlanDocument>()
    const save = vi.fn(() => gate.promise)
    const actor = start(save)
    await waitFor(actor, (snapshot) => snapshot.matches("clean"))

    actor.send({ type: "EDIT", source: source("First edit") })
    actor.send({ type: "SAVE_NOW" })
    await waitFor(actor, (snapshot) => snapshot.matches("saving"))
    actor.send({ type: "EDIT", source: source("Second edit") })
    gate.resolve(document(2, "First edit"))
    await waitFor(actor, (snapshot) => snapshot.matches("editing"))

    expect(actor.getSnapshot().context.document?.revision).toBe(2)
    expect(actor.getSnapshot().context.draft).toBe(source("Second edit"))
    actor.stop()
  })

  it("retains the complete draft after a failed save and retries it", async () => {
    const save = vi
      .fn()
      .mockRejectedValueOnce(new Error("disk full"))
      .mockResolvedValueOnce(document(2, "Local draft"))
    const actor = start(save)
    await waitFor(actor, (snapshot) => snapshot.matches("clean"))
    actor.send({ type: "EDIT", source: source("Local draft") })
    actor.send({ type: "SAVE_NOW" })
    await waitFor(actor, (snapshot) => snapshot.matches("error"))

    expect(actor.getSnapshot().context.draft).toBe(source("Local draft"))
    expect(actor.getSnapshot().context.error).toContain("disk full")
    actor.send({ type: "RETRY" })
    await waitFor(actor, (snapshot) => snapshot.matches("clean"))
    expect(save).toHaveBeenCalledTimes(2)
    actor.stop()
  })

  it("enters an explicit conflict and lets the operator keep local or accept remote", async () => {
    const remote = document(2, "Remote")
    const save = vi.fn().mockRejectedValue({
      _tag: "PlanConflictError",
      message: "revision advanced",
      latestRevision: 2,
      latest: remote
    })
    const actor = start(save)
    await waitFor(actor, (snapshot) => snapshot.matches("clean"))
    actor.send({ type: "EDIT", source: source("Local") })
    actor.send({ type: "SAVE_NOW" })
    await waitFor(actor, (snapshot) => snapshot.matches("conflict"))

    expect(actor.getSnapshot().context.remote).toStrictEqual(remote)
    expect(actor.getSnapshot().context.draft).toBe(source("Local"))
    actor.send({ type: "KEEP_LOCAL" })
    expect(actor.getSnapshot().matches("editing")).toBe(true)
    expect(actor.getSnapshot().context.document).toStrictEqual(remote)

    actor.send({ type: "REMOTE", document: document(3, "New remote") })
    expect(actor.getSnapshot().matches("conflict")).toBe(true)
    actor.send({ type: "ACCEPT_REMOTE" })
    expect(actor.getSnapshot().matches("clean")).toBe(true)
    expect(actor.getSnapshot().context.draft).toBe(source("New remote"))
    actor.stop()
  })

  it("adopts a broadcast revision while clean", async () => {
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
    const remote = document(4, "Shared")
    watched.listener?.(remote)
    await waitFor(actor, (snapshot) => snapshot.context.document?.revision === 4)
    expect(actor.getSnapshot().context.draft).toBe(source("Shared"))
    actor.stop()
  })
})
