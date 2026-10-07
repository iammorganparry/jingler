import { afterEach, expect, it, vi } from "vitest"
import { stopRoutinesBeforeQuit } from "./routine-shutdown.js"
afterEach(() => vi.useRealTimers())
it("bounds quit at fifteen elapsed seconds despite backwards wall time and finishes once after late settlement", async () => {
  vi.useFakeTimers()
  vi.setSystemTime(100_000)
  let release!: () => void
  const pending = new Promise<void>(resolve => { release = resolve })
  const finish = vi.fn(); const unresolved = vi.fn(); const failed = vi.fn()
  stopRoutinesBeforeQuit(() => pending, finish, unresolved, failed)
  await vi.advanceTimersByTimeAsync(1)
  vi.setSystemTime(0)
  await vi.advanceTimersByTimeAsync(14_998)
  expect(finish).not.toHaveBeenCalled()
  await vi.advanceTimersByTimeAsync(1)
  expect(finish).toHaveBeenCalledTimes(1); expect(unresolved).toHaveBeenCalledTimes(1)
  release(); await vi.advanceTimersByTimeAsync(1)
  expect(finish).toHaveBeenCalledTimes(1); expect(failed).not.toHaveBeenCalled()
})
it("reports stop failure and quits without waiting for the deadline", async () => {
  vi.useFakeTimers()
  const error = new Error("Unresolved ownership")
  const finish = vi.fn(); const unresolved = vi.fn(); const failed = vi.fn()
  stopRoutinesBeforeQuit(() => Promise.reject(error), finish, unresolved, failed)
  await vi.advanceTimersByTimeAsync(0)
  expect(failed).toHaveBeenCalledWith(error); expect(finish).toHaveBeenCalledTimes(1)
  await vi.advanceTimersByTimeAsync(15_000)
  expect(unresolved).not.toHaveBeenCalled(); expect(finish).toHaveBeenCalledTimes(1)
})
