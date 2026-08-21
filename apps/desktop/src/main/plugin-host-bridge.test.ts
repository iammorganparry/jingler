import { describe, expect, it, vi } from "vitest"
import { makeHostRequestHandler } from "./plugin-host-bridge.js"

const setup = (
  getSecret: (pluginId: string, settingId: string) => Promise<string | null> =
    async () => null
) =>
  makeHostRequestHandler({
    storageGet: async () => null,
    storageSet: async () => undefined,
    storageDelete: async () => undefined,
    storageKeys: async () => [],
    getWorkspaceSession: async () => null,
    getSecret,
    getProfileSecret: async () => null,
    setProfileSecret: async () => undefined,
    deleteProfileSecret: async () => undefined,
    defaultCwd: () => undefined,
    getSession: async () => null
  })

describe("plugin host session bridge", () => {
  it("resolves a renderer session id through main-owned state", async () => {
    const getWorkspaceSession = vi.fn(async () => ({
      id: "session-1",
      repo: "acme/mobile",
      branch: "feat/mobile",
      title: "Mobile",
      prNumber: null,
      worktreePath: "/trusted/mobile"
    }))
    const handle = makeHostRequestHandler({
      storageGet: async () => null,
      storageSet: async () => undefined,
      storageDelete: async () => undefined,
      storageKeys: async () => [],
      getWorkspaceSession,
      getSecret: async () => null,
      getProfileSecret: async () => null,
      setProfileSecret: async () => undefined,
      deleteProfileSecret: async () => undefined,
      defaultCwd: () => undefined,
      getSession: async () => null
    })

    const reply = await handle("expo", "sessions.get", { sessionId: "session-1" })

    expect(getWorkspaceSession).toHaveBeenCalledWith("session-1")
    expect(reply).toMatchObject({ ok: true, value: { worktreePath: "/trusted/mobile" } })
  })
})

describe("plugin host settings bridge", () => {
  it("resolves a secret in the requesting plugin's namespace", async () => {
    const getSecret = vi.fn(async () => "lin_api_secret")
    const handle = setup(getSecret)

    const reply = await handle("linear", "settings.getSecret", {
      settingId: "linear.api-key"
    })

    expect(getSecret).toHaveBeenCalledWith("linear", "linear.api-key")
    expect(reply).toEqual({ ok: true, value: "lin_api_secret" })
  })

  it("does not accept a target plugin id in the payload", async () => {
    const getSecret = vi.fn(async () => "linear-secret")
    const handle = setup(getSecret)

    await handle("linear", "settings.getSecret", {
      settingId: "linear.api-key",
      pluginId: "github"
    })

    // The namespace comes only from the host-request envelope that the context
    // bound at activation; payload data cannot redirect it to another plugin.
    expect(getSecret).toHaveBeenCalledWith("linear", "linear.api-key")
  })

  it("writes named profile secrets only inside the requesting plugin namespace", async () => {
    const setProfileSecret = vi.fn(async () => undefined)
    const handle = makeHostRequestHandler({
      storageGet: async () => null,
      storageSet: async () => undefined,
      storageDelete: async () => undefined,
      storageKeys: async () => [],
      getWorkspaceSession: async () => null,
      getSecret: async () => null,
      getProfileSecret: async () => null,
      setProfileSecret,
      deleteProfileSecret: async () => undefined,
      defaultCwd: () => undefined,
      getSession: async () => null
    })

    const reply = await handle("linear", "settings.setProfileSecret", {
      collectionId: "linear.accounts",
      profileId: "work",
      value: "lin_api_secret",
      pluginId: "github"
    })

    expect(setProfileSecret).toHaveBeenCalledWith(
      "linear",
      "linear.accounts",
      "work",
      "lin_api_secret"
    )
    expect(reply).toEqual({ ok: true, value: undefined })
  })

  it("returns a refusal without including a secret value", async () => {
    const handle = setup(
      vi.fn(async () => {
        throw new Error("setting is not declared")
      })
    )

    const reply = await handle("linear", "settings.getSecret", {
      settingId: "linear.unknown"
    })

    expect(reply).toEqual({ ok: false, message: "setting is not declared" })
  })
})
