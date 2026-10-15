import { createActor, waitFor } from "xstate"
import { describe, expect, it, vi } from "vitest"
import { commentComposerMachine } from "./comment-composer-machine.js"

const start = (post: (body: string, close: boolean) => Promise<void>) =>
  createActor(commentComposerMachine, { input: { post } }).start()

describe("commentComposerMachine", () => {
  it("ignores an empty draft", () => {
    const post = vi.fn().mockResolvedValue(undefined)
    const actor = start(post)
    actor.send({ type: "CHANGE", draft: "  " })
    actor.send({ type: "SUBMIT", close: false })
    expect(actor.getSnapshot().value).toBe("idle")
    expect(post).not.toHaveBeenCalled()
  })

  it("posts, clears the draft, and passes the close flag", async () => {
    const post = vi.fn().mockResolvedValue(undefined)
    const actor = start(post)
    actor.send({ type: "CHANGE", draft: "Done" })
    actor.send({ type: "SUBMIT", close: true })
    expect(actor.getSnapshot().value).toBe("posting")
    await waitFor(actor, (s) => s.value === "idle")
    expect(post).toHaveBeenCalledWith("Done", true)
    expect(actor.getSnapshot().context.draft).toBe("")
  })

  it("keeps the draft and records the error when the post fails", async () => {
    const actor = start(vi.fn().mockRejectedValue(new Error("denied")))
    actor.send({ type: "CHANGE", draft: "Looking" })
    actor.send({ type: "SUBMIT", close: false })
    await waitFor(actor, (s) => s.value === "idle")
    expect(actor.getSnapshot().context).toMatchObject({ draft: "Looking", error: "denied" })
    actor.send({ type: "CHANGE", draft: "Looking again" })
    expect(actor.getSnapshot().context.error).toBeNull()
  })
})
