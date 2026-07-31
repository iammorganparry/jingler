import { createActor, waitFor } from "xstate"
import { describe, expect, it, vi } from "vitest"
import { planCommentComposerMachine } from "./plan-comment-composer-machine.js"

describe("planCommentComposerMachine", () => {
  it("keeps the draft and mention routing coupled through edits", () => {
    const actor = createActor(planCommentComposerMachine, {
      input: { getOnSubmit: () => vi.fn() }
    }).start()

    actor.send({ type: "change", value: "Ask @wor" })
    actor.send({
      type: "choose",
      value: "Ask @worker-ui ",
      mention: { routingId: "worker:plan:ui:1", token: "@worker-ui" }
    })
    expect(actor.getSnapshot().context.mentioned).toEqual([
      { routingId: "worker:plan:ui:1", token: "@worker-ui" }
    ])

    actor.send({ type: "change", value: "No agent needed" })
    expect(actor.getSnapshot().context).toMatchObject({
      value: "No agent needed",
      mentioned: [],
      activeIndex: 0
    })
  })

  it("owns async submission and only clears after confirmed success", async () => {
    const onSubmit = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true)
    const actor = createActor(planCommentComposerMachine, {
      input: { getOnSubmit: () => onSubmit }
    }).start()

    actor.send({ type: "change", value: "Keep until sent" })
    actor.send({ type: "submit" })
    await waitFor(actor, (snapshot) => snapshot.matches("editing"))
    expect(actor.getSnapshot().context.value).toBe("Keep until sent")

    actor.send({ type: "submit" })
    await waitFor(
      actor,
      (snapshot) => snapshot.matches("editing") && snapshot.context.value === ""
    )
    expect(onSubmit).toHaveBeenCalledTimes(2)
  })
})
