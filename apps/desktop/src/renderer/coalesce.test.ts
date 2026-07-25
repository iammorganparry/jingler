import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createCoalescer } from "./coalesce.js"

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

describe("createCoalescer", () => {
  it("delivers only the last value pushed for a key in a window", () => {
    const batches: Array<ReadonlyArray<readonly [string, number]>> = []
    const c = createCoalescer<number>((b) => batches.push(b), 100)

    c.push("a", 1)
    c.push("a", 2)
    c.push("a", 3)
    expect(batches).toEqual([])

    vi.advanceTimersByTime(100)
    expect(batches).toEqual([[["a", 3]]])
  })

  it("batches several keys into one flush", () => {
    const batches: Array<ReadonlyArray<readonly [string, number]>> = []
    const c = createCoalescer<number>((b) => batches.push(b), 100)

    c.push("a", 1)
    c.push("b", 2)
    vi.advanceTimersByTime(100)

    expect(batches).toEqual([
      [
        ["a", 1],
        ["b", 2]
      ]
    ])
  })

  it("flushes at a steady rate under a continuous stream, rather than never", () => {
    // The distinction from a debounce, and the whole point: an agent streaming
    // tokens without pause must still see its sidebar update. A deadline that
    // reset on every push would starve until the run finished.
    const batches: Array<ReadonlyArray<readonly [string, number]>> = []
    const c = createCoalescer<number>((b) => batches.push(b), 100)

    for (let i = 0; i < 10; i++) {
      c.push("a", i)
      vi.advanceTimersByTime(50)
    }

    expect(batches.length).toBeGreaterThanOrEqual(4)
  })

  it("schedules a fresh window for a value pushed from inside the flush", () => {
    const seen: Array<number> = []
    let reentered = false
    const c = createCoalescer<number>((batch) => {
      for (const [, value] of batch) seen.push(value)
      if (!reentered) {
        reentered = true
        c.push("a", 99)
      }
    }, 100)

    c.push("a", 1)
    vi.advanceTimersByTime(100)
    expect(seen).toEqual([1])

    // Swallowing this would mean the last snapshot of a turn never publishes.
    vi.advanceTimersByTime(100)
    expect(seen).toEqual([1, 99])
  })

  it("drops a cancelled key without disturbing the rest of the batch", () => {
    const batches: Array<ReadonlyArray<readonly [string, number]>> = []
    const c = createCoalescer<number>((b) => batches.push(b), 100)

    c.push("a", 1)
    c.push("b", 2)
    c.cancel("a")
    vi.advanceTimersByTime(100)

    expect(batches).toEqual([[["b", 2]]])
  })

  it("does not flush an empty queue", () => {
    const flush = vi.fn()
    const c = createCoalescer<number>(flush, 100)

    c.push("a", 1)
    c.cancel("a")
    vi.advanceTimersByTime(100)
    expect(flush).not.toHaveBeenCalled()

    c.flushNow()
    expect(flush).not.toHaveBeenCalled()
  })

  it("flushNow delivers immediately and clears the pending timer", () => {
    const flush = vi.fn()
    const c = createCoalescer<number>(flush, 100)

    c.push("a", 1)
    c.flushNow()
    expect(flush).toHaveBeenCalledTimes(1)

    // No second delivery from the timer that was in flight.
    vi.advanceTimersByTime(500)
    expect(flush).toHaveBeenCalledTimes(1)
  })
})
