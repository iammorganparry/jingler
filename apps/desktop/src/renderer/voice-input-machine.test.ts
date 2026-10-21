import { createActor, waitFor } from "xstate"
import { describe, expect, it, vi } from "vitest"
import { voiceInputMachine, type VoiceInputDeps } from "./voice-input-machine.js"

const setup = (over: Partial<VoiceInputDeps> = {}) => {
  const recording = { stop: vi.fn(async () => "d2F2"), cancel: vi.fn() }
  const deps: VoiceInputDeps = { start: async () => recording, transcribe: async () => "hello world", onTranscript: vi.fn(), ...over }
  const actor = createActor(voiceInputMachine, { input: deps }).start()
  return { actor, deps, recording }
}

describe("voiceInputMachine", () => {
  it("records, transcribes, hands the transcript over and returns to idle", async () => {
    const { actor, deps } = setup()
    actor.send({ type: "TOGGLE" })
    await waitFor(actor, (s) => s.matches("recording"))
    actor.send({ type: "TOGGLE" })
    await waitFor(actor, (s) => s.matches("idle"))
    expect(deps.onTranscript).toHaveBeenCalledWith("hello world")
  })

  it("cancel discards the recording without transcribing", async () => {
    const transcribe = vi.fn(async () => "x")
    const { actor, recording, deps } = setup({ transcribe })
    actor.send({ type: "TOGGLE" })
    await waitFor(actor, (s) => s.matches("recording"))
    actor.send({ type: "CANCEL" })
    expect(actor.getSnapshot().matches("idle")).toBe(true)
    expect(recording.cancel).toHaveBeenCalled()
    expect(transcribe).not.toHaveBeenCalled()
    expect(deps.onTranscript).not.toHaveBeenCalled()
  })

  it("lands in noModel on a no-model failure and in error otherwise", async () => {
    const a = setup({ transcribe: async () => { throw { reason: "no-model", message: "m" } } })
    a.actor.send({ type: "TOGGLE" })
    await waitFor(a.actor, (s) => s.matches("recording"))
    a.actor.send({ type: "TOGGLE" })
    await waitFor(a.actor, (s) => s.matches("noModel"))

    const b = setup({ start: async () => { throw new Error("denied") } })
    b.actor.send({ type: "TOGGLE" })
    await waitFor(b.actor, (s) => s.matches("error"))
    expect(b.actor.getSnapshot().context.error).toBe("denied")
    b.actor.send({ type: "DISMISS" })
    expect(b.actor.getSnapshot().matches("idle")).toBe(true)
  })
})
