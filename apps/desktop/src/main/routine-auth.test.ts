import { Effect } from "effect"
import { expect, it, vi } from "vitest"
import { revalidateRoutineAuth, routineStartup } from "./routine-auth.js"

it("authoritatively rejects revoked authentication before the next operation", async () => {
  const create = vi.fn()
  await expect(Effect.runPromise(revalidateRoutineAuth(() => Effect.succeed(null)).pipe(Effect.tap(() => Effect.sync(create))))).rejects.toThrow("Sign in")
  expect(create).not.toHaveBeenCalled()
})
it("bounds unreachable authoritative authentication without running the operation", async () => {
  vi.useFakeTimers()
  try {
    const prompt = vi.fn()
    const result = Effect.runPromise(revalidateRoutineAuth(() => Effect.never).pipe(Effect.tap(() => Effect.sync(prompt)), Effect.uninterruptible))
    const rejection = expect(result).rejects.toThrow("revalidation timed out")
    await vi.advanceTimersByTimeAsync(10_000); await rejection
    expect(prompt).not.toHaveBeenCalled()
  } finally { vi.useRealTimers() }
})
it("shares an inflight startup and retries a failed attempt", async () => {
  let reject!: (error: Error) => void
  const start = vi.fn().mockImplementationOnce(() => new Promise<void>((_, failure) => { reject = failure })).mockResolvedValue(undefined)
  const startup = routineStartup(start)
  const first = startup(); const concurrent = startup()
  expect(concurrent).toBe(first); expect(start).toHaveBeenCalledTimes(1)
  const rejection = expect(first).rejects.toThrow("temporary")
  reject(new Error("temporary")); await rejection
  await startup(); expect(start).toHaveBeenCalledTimes(2)
})
