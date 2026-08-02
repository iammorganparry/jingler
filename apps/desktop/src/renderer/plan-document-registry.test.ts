import type { PlanDocument } from "@jingler/core"
import { waitFor } from "xstate"
import { afterEach, describe, expect, it } from "vitest"
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

const sessions = new Set<string>()
afterEach(() => {
  for (const sessionId of sessions) stopPlanDocument(sessionId)
  sessions.clear()
})

describe("plan document registry", () => {
  it("keeps the loaded document alive across view remounts", async () => {
    const sessionId = "registry-remount"
    sessions.add(sessionId)
    const input = {
      sessionId,
      load: async () => document(sessionId)
    }
    const firstView = getPlanDocumentActor(sessionId, input)
    await waitFor(firstView, (snapshot) => snapshot.matches("clean"))

    const remountedView = getPlanDocumentActor(sessionId, input)
    expect(remountedView).toBe(firstView)
    expect(remountedView.getSnapshot().context.document?.revision).toBe(1)
  })

  it("resolves a flush immediately for the read-only plan", async () => {
    const sessionId = "registry-flush"
    sessions.add(sessionId)
    const actor = getPlanDocumentActor(sessionId, {
      sessionId,
      load: async () => document(sessionId)
    })
    await waitFor(actor, (snapshot) => snapshot.matches("clean"))

    await expect(flushPlanDocumentActor(actor)).resolves.toBeUndefined()
    expect(actor.getSnapshot().matches("clean")).toBe(true)
  })
})
