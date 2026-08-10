import { describe, expect, it } from "vitest"
import { FakePiProvider } from "./fake-pi-provider.js"

describe("fake pi provider", () => {
  it("replays deterministic observations and invalid tool arguments", async () => {
    const provider = new FakePiProvider([
      { kind: "observation", value: { kind: "event", tag: "Started" } },
      { kind: "invalid-tool-arguments", tool: "workspace.edit" },
      { kind: "observation", value: { kind: "event", tag: "Done" } }
    ])
    expect(await provider.next()).toMatchObject({ kind: "observation" })
    expect(await provider.next()).toEqual({ kind: "invalid-tool-arguments", tool: "workspace.edit" })
    expect(await provider.next()).toMatchObject({ kind: "observation" })
    expect(provider.observations).toHaveLength(2)
    expect(await provider.next()).toBeNull()
  })

  it("stops deterministically at an abort boundary", async () => {
    const provider = new FakePiProvider([{ kind: "wait-for-abort" }])
    const abort = new AbortController()
    const pending = provider.next(abort.signal)
    abort.abort()
    await expect(pending).resolves.toEqual({ kind: "wait-for-abort" })
  })

  it("emits scripted failures", async () => {
    const provider = new FakePiProvider([{ kind: "failure", message: "fixture-failure" }])
    await expect(provider.next()).rejects.toThrow("fixture-failure")
  })
})
