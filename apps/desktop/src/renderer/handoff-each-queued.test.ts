import { describe, expect, it, vi } from "vitest"
import { handoffEachQueued } from "./handoff-each-queued.js"

describe("handoffEachQueued", () => {
  it("hands off every queued item, clears the queue, and reports the count once", () => {
    let queue = ["q1", "q2", "q3"]
    const handoff = vi.fn((id: string, done: () => void) => {
      queue = queue.filter((queued) => queued !== id)
      done()
    })
    const onAll = vi.fn()
    handoffEachQueued(queue, handoff, onAll)
    expect(handoff.mock.calls.map(([id]) => id)).toEqual(["q1", "q2", "q3"])
    expect(queue).toEqual([])
    expect(onAll).toHaveBeenCalledOnce()
    expect(onAll).toHaveBeenCalledWith(3)
  })

  it("stays silent when a hand-off never lands", () => {
    const onAll = vi.fn()
    handoffEachQueued(["q1", "q2"], (id, done) => id === "q1" && done(), onAll)
    expect(onAll).not.toHaveBeenCalled()
  })
})
