import { describe, expect, it, vi } from "vitest"
import { createActor, fromPromise, waitFor } from "xstate"
import { type LoginMethod, type SaveApiKeyResult, providerConnectMachine } from "./provider-connect-machine.js"

const deferred = () => {
  let resolve!: () => void
  let reject!: (error: Error) => void
  const promise = new Promise<void>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

const start = (overrides: {
  login?: (method: LoginMethod) => Promise<void>
  cancelLogin?: () => Promise<void>
  saveApiKey?: (providerId: string, apiKey: string) => Promise<SaveApiKeyResult>
  connected?: () => void
  close?: () => void
} = {}) => {
  const actor = createActor(
    providerConnectMachine.provide({
      actors: {
        login: fromPromise(({ input }) => (overrides.login ?? (async () => {}))(input.method)),
        cancelLogin: fromPromise(() => (overrides.cancelLogin ?? (async () => {}))()),
        saveApiKey: fromPromise(({ input }) =>
          (overrides.saveApiKey ?? (async () => ({ ok: true as const })))(input.providerId, input.apiKey)
        )
      },
      actions: { connected: overrides.connected ?? (() => {}), close: overrides.close ?? (() => {}) }
    }),
    { input: { apiProvider: "anthropic" } }
  )
  actor.start()
  return actor
}

describe("providerConnectMachine", () => {
  it("stays connecting for the whole login, then connects and closes", async () => {
    const login = deferred()
    const connected = vi.fn()
    const close = vi.fn()
    const actor = start({ login: () => login.promise, connected, close })
    actor.send({ type: "START", method: "device-code" })
    expect(actor.getSnapshot().matches({ subscription: "connecting" })).toBe(true)
    expect(actor.getSnapshot().context.method).toBe("device-code")

    login.resolve()
    await waitFor(actor, (s) => s.matches({ subscription: "connected" }))
    expect(connected).toHaveBeenCalledOnce()
    expect(close).toHaveBeenCalledOnce()
  })

  it("Cancel calls cancelLogin and returns to idle", async () => {
    const cancelLogin = vi.fn(async () => {})
    const actor = start({ login: () => new Promise(() => {}), cancelLogin })
    actor.send({ type: "START", method: "browser" })
    actor.send({ type: "CANCEL" })
    await waitFor(actor, (s) => s.matches({ subscription: "idle" }))
    expect(cancelLogin).toHaveBeenCalledOnce()
  })

  it("returns to idle with the error when the login fails", async () => {
    const actor = start({ login: () => Promise.reject(new Error("Claude CLI is not signed in")) })
    actor.send({ type: "START", method: "claude-cli" })
    await waitFor(actor, (s) => s.matches({ subscription: "idle" }) && s.context.error !== null)
    expect(actor.getSnapshot().context.error).toBe("Claude CLI is not signed in")
  })

  it("keeps a rejected key, then verifies a corrected one and closes only on Done", async () => {
    const close = vi.fn()
    const saveApiKey = vi.fn(async (_provider: string, key: string): Promise<SaveApiKeyResult> =>
      key === "sk-good" ? { ok: true } : { ok: false, error: "Key rejected" }
    )
    const actor = start({ saveApiKey, close })
    actor.send({ type: "SELECT_API_KEY" })
    actor.send({ type: "SUBMIT_API_KEY" })
    expect(actor.getSnapshot().matches({ apiKey: "editing" })).toBe(true)

    actor.send({ type: "EDIT_API_PROVIDER", value: "openai" })
    actor.send({ type: "EDIT_API_KEY", value: " sk-bad " })
    actor.send({ type: "SUBMIT_API_KEY" })
    await waitFor(actor, (s) => s.matches({ apiKey: "invalid" }))
    expect(saveApiKey).toHaveBeenCalledWith("openai", "sk-bad")
    expect(actor.getSnapshot().context).toMatchObject({ apiKey: " sk-bad ", error: "Key rejected" })

    actor.send({ type: "EDIT_API_KEY", value: "sk-good" })
    expect(actor.getSnapshot().context.error).toBeNull()
    actor.send({ type: "SUBMIT_API_KEY" })
    await waitFor(actor, (s) => s.matches({ apiKey: "verified" }))
    expect(close).not.toHaveBeenCalled()

    actor.send({ type: "DONE" })
    expect(close).toHaveBeenCalledOnce()
  })
})
