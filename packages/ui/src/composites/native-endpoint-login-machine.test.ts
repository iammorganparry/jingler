// @vitest-environment node
import { createActor, waitFor } from "xstate"
import { describe, expect, it, vi } from "vitest"
import { nativeEndpointLoginMachine } from "./native-endpoint-login-machine.js"

const code = { loginId: "login", verificationUrl: "https://example.com", userCode: "CODE" }
const input = () => ({ endpointId: "device:codex:default", targetId: "device", actions: {
  start: vi.fn(async () => code), cancel: vi.fn(async () => {}), refresh: vi.fn(async () => true)
} })
describe("native login lifecycle", () => {
  it("refreshes target status and disposes the owned login after completion", async () => {
    const options = input()
    const actor = createActor(nativeEndpointLoginMachine, { input: options }).start()
    actor.send({ type: "START" })
    await waitFor(actor, (s) => s.matches({ active: "waiting" }))
    expect(actor.getSnapshot().context.code).toEqual(code)
    actor.send({ type: "CHECK" })
    await waitFor(actor, (s) => s.matches("done"))
    expect(options.actions.refresh).toHaveBeenCalledWith(options.endpointId, "device")
    expect(options.actions.cancel).toHaveBeenCalledWith(options.endpointId, "device", "login")
    actor.stop()
  })
  it("cancels a late start after unmount", async () => {
    const options = input()
    let complete!: (value: typeof code) => void
    options.actions.start.mockImplementation(() => new Promise((resolve) => { complete = resolve }))
    const actor = createActor(nativeEndpointLoginMachine, { input: options }).start()
    actor.send({ type: "START" })
    actor.stop()
    complete(code)
    await vi.waitFor(() => expect(options.actions.cancel).toHaveBeenCalledTimes(1))
  })
  it("keeps pending sign-in visible and cancels on operator request", async () => {
    const options = input()
    options.actions.refresh.mockResolvedValue(false)
    const actor = createActor(nativeEndpointLoginMachine, { input: options }).start()
    actor.send({ type: "START" })
    await waitFor(actor, (s) => s.matches({ active: "waiting" }))
    actor.send({ type: "CHECK" })
    await waitFor(actor, (s) => s.context.error !== null)
    expect(actor.getSnapshot().matches({ active: "waiting" })).toBe(true)
    actor.send({ type: "CANCEL" })
    expect(options.actions.cancel).toHaveBeenCalledTimes(1)
    actor.stop()
  })
})
