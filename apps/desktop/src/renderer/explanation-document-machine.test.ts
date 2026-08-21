import type { ExplanationDocument } from "@jingler/core"
import { createActor } from "xstate"
import { describe, expect, it, vi } from "vitest"
import { explanationDocumentMachine } from "./explanation-document-machine.js"

const document = (revision: number, title = "Explanation"): ExplanationDocument => ({
  id: "explanation-1",
  sessionId: "session-1",
  producingChatId: "chat-1",
  revision,
  title,
  summary: "A focused visual.",
  sections: [],
  updatedAt: `2026-08-12T12:00:0${revision}.000Z`
})

const settled = async (actor: ReturnType<typeof createActor<typeof explanationDocumentMachine>>) => {
  await vi.waitFor(() => expect(actor.getSnapshot().matches("loading")).toBe(false))
}

describe("explanationDocumentMachine", () => {
  it("loads and advances remote revisions", async () => {
    let remote: (value: ExplanationDocument | null) => void = () => {}
    const actor = createActor(explanationDocumentMachine, {
      input: {
        sessionId: "session-1",
        load: async () => document(1),
        subscribe: (listener) => {
          remote = listener
          return () => {}
        }
      }
    }).start()
    await settled(actor)
    remote(document(2, "Updated"))
    expect(actor.getSnapshot().context.document).toMatchObject({ revision: 2, title: "Updated" })
    remote(document(1, "Stale"))
    expect(actor.getSnapshot().context.document?.title).toBe("Updated")
    actor.stop()
  })

  it("recovers from load errors through retry", async () => {
    let attempts = 0
    const actor = createActor(explanationDocumentMachine, {
      input: {
        sessionId: "session-1",
        load: async () => {
          attempts += 1
          if (attempts === 1) throw new Error("offline")
          return document(1)
        }
      }
    }).start()
    await vi.waitFor(() => expect(actor.getSnapshot().matches("error")).toBe(true))
    expect(actor.getSnapshot().context.error).toBe("offline")
    actor.send({ type: "RETRY" })
    await settled(actor)
    expect(actor.getSnapshot().context.document?.revision).toBe(1)
    actor.stop()
  })
})
