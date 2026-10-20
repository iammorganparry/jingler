import { describe, expect, test } from "vitest"
import { createActor } from "xstate"
import { prStackMachine } from "./pr-stack-machine.js"

const start = (numbers = [480, 481, 482], current?: number) =>
  createActor(prStackMachine, { input: { numbers, current } }).start()

describe("prStackMachine selection", () => {
  test("defaults to the top layer and clamps at both ends", () => {
    const actor = start()
    expect(actor.getSnapshot().context.selected).toBe(482)
    actor.send({ type: "NEXT" })
    expect(actor.getSnapshot().context.selected).toBe(482)
    actor.send({ type: "PREV" })
    actor.send({ type: "PREV" })
    actor.send({ type: "PREV" })
    expect(actor.getSnapshot().context.selected).toBe(480)
  })

  test("NEXT moves up the stack, base-up", () => {
    const actor = start([480, 481, 482], 480)
    actor.send({ type: "NEXT" })
    expect(actor.getSnapshot().context.selected).toBe(481)
  })

  test("SELECT ignores numbers outside the stack", () => {
    const actor = start()
    actor.send({ type: "SELECT", number: 481 })
    actor.send({ type: "SELECT", number: 999 })
    expect(actor.getSnapshot().context.selected).toBe(481)
  })

  test("STACK_CHANGED keeps a still-present selection, else falls back to current", () => {
    const actor = start([480, 481, 482], 481)
    actor.send({ type: "STACK_CHANGED", numbers: [480, 481] })
    expect(actor.getSnapshot().context.selected).toBe(481)
    actor.send({ type: "STACK_CHANGED", numbers: [480], current: 480 })
    expect(actor.getSnapshot().context.selected).toBe(480)
    actor.send({ type: "STACK_CHANGED", numbers: [] })
    expect(actor.getSnapshot().context.selected).toBeNull()
  })
})

describe("prStackMachine merge progress", () => {
  test("counts merged layers until the whole stack is merged", () => {
    const actor = start()
    actor.send({ type: "MERGE_STACK" })
    expect(actor.getSnapshot().value).toBe("merging")
    actor.send({ type: "LAYER_MERGED" })
    expect(actor.getSnapshot().context.merged).toBe(1)
    actor.send({ type: "LAYER_MERGED" })
    actor.send({ type: "LAYER_MERGED" })
    expect(actor.getSnapshot().value).toBe("merged")
    expect(actor.getSnapshot().context.merged).toBe(3)
  })

  test("a failure keeps progress and a retry restarts it", () => {
    const actor = start()
    actor.send({ type: "MERGE_STACK" })
    actor.send({ type: "LAYER_MERGED" })
    actor.send({ type: "MERGE_FAILED", message: "conflict" })
    expect(actor.getSnapshot().value).toBe("failed")
    expect(actor.getSnapshot().context).toMatchObject({ merged: 1, mergeError: "conflict" })
    actor.send({ type: "MERGE_STACK" })
    expect(actor.getSnapshot().context).toMatchObject({ merged: 0, mergeError: null })
    expect(actor.getSnapshot().value).toBe("merging")
  })

  test("a failing layer stops the run: later LAYER_MERGED events are ignored once failed", () => {
    const actor = start()
    actor.send({ type: "MERGE_STACK" })
    actor.send({ type: "LAYER_MERGED" }) // base layer merges fine
    actor.send({ type: "MERGE_FAILED", message: "conflict on #481" })
    expect(actor.getSnapshot().value).toBe("failed")
    // A driver that (incorrectly) kept going past the failure must not move progress.
    actor.send({ type: "LAYER_MERGED" })
    expect(actor.getSnapshot().context.merged).toBe(1)
    expect(actor.getSnapshot().value).toBe("failed")
  })

  test("merges base-up: progress advances one layer at a time in stack order", () => {
    // The driver (use-pr-stack.ts) walks `numbers`, bottom layer first, sending one
    // LAYER_MERGED per successful RPC — this asserts the machine counts each step
    // rather than jumping straight to "merged".
    const actor = start([480, 481, 482])
    actor.send({ type: "MERGE_STACK" })
    actor.send({ type: "LAYER_MERGED" }) // #480, the base
    expect(actor.getSnapshot().context.merged).toBe(1)
    expect(actor.getSnapshot().value).toBe("merging")
    actor.send({ type: "LAYER_MERGED" }) // #481
    expect(actor.getSnapshot().context.merged).toBe(2)
    expect(actor.getSnapshot().value).toBe("merging")
    actor.send({ type: "LAYER_MERGED" }) // #482, the top
    expect(actor.getSnapshot().context.merged).toBe(3)
    expect(actor.getSnapshot().value).toBe("merged")
  })
})
