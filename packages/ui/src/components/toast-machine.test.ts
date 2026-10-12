import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createActor } from "xstate"
import { MAX_VISIBLE_TOASTS, TOAST_DURATION_MS, toastMachine, type ToastInput } from "./toast-machine.js"

const toast = (key: string, extra: Partial<ToastInput> = {}): ToastInput => ({
  key,
  variant: "info",
  title: key,
  ...extra
})

const start = (isSessionVisible?: (id: string) => boolean) =>
  createActor(toastMachine, { input: { isSessionVisible } }).start()
const keys = (actor: ReturnType<typeof start>) => actor.getSnapshot().context.toasts.map((t) => t.key)

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

describe("toastMachine", () => {
  it("auto-dismisses after the timeout", () => {
    const actor = start()
    actor.send({ type: "PUSH", toast: toast("a") })
    vi.advanceTimersByTime(TOAST_DURATION_MS - 200)
    expect(keys(actor)).toEqual(["a"])
    vi.advanceTimersByTime(300)
    expect(keys(actor)).toEqual([])
    expect(actor.getSnapshot().value).toBe("idle")
  })

  it("evicts the oldest when a fourth toast arrives", () => {
    const actor = start()
    for (const key of ["a", "b", "c", "d"]) actor.send({ type: "PUSH", toast: toast(key) })
    expect(MAX_VISIBLE_TOASTS).toBe(3)
    expect(keys(actor)).toEqual(["b", "c", "d"])
  })

  it("pauses while hovered and resumes after", () => {
    const actor = start()
    actor.send({ type: "PUSH", toast: toast("a") })
    actor.send({ type: "PAUSE" })
    vi.advanceTimersByTime(TOAST_DURATION_MS * 3)
    expect(keys(actor)).toEqual(["a"])
    actor.send({ type: "RESUME" })
    vi.advanceTimersByTime(TOAST_DURATION_MS)
    expect(keys(actor)).toEqual([])
  })

  it("dedupes by key in place and restarts the timer", () => {
    const actor = start()
    actor.send({ type: "PUSH", toast: toast("a") })
    actor.send({ type: "PUSH", toast: toast("b") })
    vi.advanceTimersByTime(4000)
    actor.send({ type: "PUSH", toast: toast("a", { title: "a again" }) })
    expect(actor.getSnapshot().context.toasts.map((t) => t.title)).toEqual(["a again", "b"])
    vi.advanceTimersByTime(3000)
    expect(keys(actor)).toEqual(["a"])
  })

  it("dismisses manually", () => {
    const actor = start()
    actor.send({ type: "PUSH", toast: toast("a") })
    actor.send({ type: "PUSH", toast: toast("b") })
    actor.send({ type: "DISMISS", key: "a" })
    expect(keys(actor)).toEqual(["b"])
  })

  it("drops toasts for the session the user is already viewing", () => {
    const actor = start((id) => id === "s-1")
    actor.send({ type: "PUSH", toast: toast("a", { sessionId: "s-1" }) })
    actor.send({ type: "PUSH", toast: toast("b", { sessionId: "s-2" }) })
    expect(keys(actor)).toEqual(["b"])
  })

  it("ticks again after going idle and being paused while empty", () => {
    const actor = start()
    actor.send({ type: "PUSH", toast: toast("a") })
    actor.send({ type: "PAUSE" })
    actor.send({ type: "DISMISS", key: "a" })
    expect(actor.getSnapshot().value).toBe("idle")
    actor.send({ type: "PUSH", toast: toast("b") })
    vi.advanceTimersByTime(TOAST_DURATION_MS + 200)
    expect(keys(actor)).toEqual([])
  })
})
