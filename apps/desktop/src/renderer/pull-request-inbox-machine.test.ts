import type { GitHubTeamDiscovery, PullRequestListItem } from "@jingler/core"
import { afterEach, describe, expect, it, vi } from "vitest"
import { createActor, waitFor } from "xstate"
import { pullRequestInboxMachine } from "./pull-request-inbox-machine.js"

const team = { id: "7", organization: "acme", slug: "platform", name: "Platform" }
const discovery = (id = "1", teams = [team]): GitHubTeamDiscovery => ({ account: { id, login: `user${id}` }, teams })
const setupStorage = () => {
  const storage = new Map<string, string>()
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
  })
  return storage
}
afterEach(() => vi.unstubAllGlobals())

describe("pullRequestInboxMachine", () => {
  it("persists per account, resets detail on queue switches, and restores only current memberships", async () => {
    const storage = setupStorage()
    let current = discovery()
    const actor = createActor(pullRequestInboxMachine, { input: { discover: async () => current } }).start()
    actor.send({ type: "DISCOVER" })
    await waitFor(actor, (state) => state.matches("ready"))
    actor.send({ type: "TEAM", teamId: "7" })
    actor.send({ type: "SELECT", pr: { number: 42 } as PullRequestListItem })
    actor.send({ type: "QUEUE", queue: "authored" })
    expect(actor.getSnapshot().context.selected).toBeNull()
    expect(JSON.parse(storage.get("jingler.pr-inbox.team.1")!)).toEqual({ teamId: "7", queue: "authored" })

    current = discovery("2")
    actor.send({ type: "DISCOVER" })
    expect(actor.getSnapshot().context.selected).toBeNull()
    await waitFor(actor, (state) => state.matches("ready"))
    expect(actor.getSnapshot().context.teamId).toBeNull()
    expect(actor.getSnapshot().context.account?.id).toBe("2")
    actor.send({ type: "TEAM", teamId: "7" })
    actor.send({ type: "QUEUE", queue: "repositories" })

    current = discovery("1")
    actor.send({ type: "DISCOVER" })
    await waitFor(actor, (state) => state.matches("ready"))
    expect(actor.getSnapshot().context).toMatchObject({ teamId: "7", queue: "authored" })
    current = discovery("1", [])
    actor.send({ type: "DISCOVER" })
    await waitFor(actor, (state) => state.matches("ready"))
    expect(actor.getSnapshot().context.teamId).toBeNull()
    expect(JSON.parse(storage.get("jingler.pr-inbox.team.1")!).teamId).toBeNull()
    actor.stop()
  })

  it("preserves active selection on same-account refresh but clears it for changed accounts or removed teams", async () => {
    setupStorage()
    let current = discovery()
    const actor = createActor(pullRequestInboxMachine, { input: { discover: async () => current } }).start()
    actor.send({ type: "DISCOVER" })
    await waitFor(actor, (state) => state.matches("ready"))
    actor.send({ type: "TEAM", teamId: "7" })
    const selected = { repository: "acme/widget", number: 42 } as PullRequestListItem
    actor.send({ type: "SELECT", pr: selected })
    actor.send({ type: "DISCOVER" })
    expect(actor.getSnapshot().context.selected).toBe(selected)
    await waitFor(actor, (state) => state.matches("ready"))
    expect(actor.getSnapshot().context.selected).toBe(selected)
    current = discovery("2")
    actor.send({ type: "DISCOVER" })
    await waitFor(actor, (state) => state.matches("ready"))
    expect(actor.getSnapshot().context.selected).toBeNull()
    actor.send({ type: "TEAM", teamId: "7" })
    actor.send({ type: "SELECT", pr: selected })
    current = discovery("2", [])
    actor.send({ type: "DISCOVER" })
    await waitFor(actor, (state) => state.matches("ready"))
    expect(actor.getSnapshot().context.selected).toBeNull()
    expect(actor.getSnapshot().context.teamId).toBeNull()
    actor.stop()
  })

  it("ignores stale discovery completion after a new account refresh", async () => {
    setupStorage()
    let resolveOld!: (value: GitHubTeamDiscovery) => void
    let calls = 0
    const actor = createActor(pullRequestInboxMachine, { input: { discover: () => {
      calls++
      return calls === 1 ? new Promise((resolve) => { resolveOld = resolve }) : Promise.resolve(discovery("2"))
    } } }).start()
    actor.send({ type: "DISCOVER" })
    actor.send({ type: "DISCOVER" })
    await waitFor(actor, (state) => state.matches("ready"))
    resolveOld(discovery("1"))
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(actor.getSnapshot().context.account?.id).toBe("2")
    actor.stop()
  })

  it("rejects forged teams/corrupt persistence and exposes discovery failures with retry", async () => {
    const storage = setupStorage()
    storage.set("jingler.pr-inbox.team.1", '{"teamId":"other","queue":"not-a-queue"}')
    let failed = true
    const actor = createActor(pullRequestInboxMachine, { input: { discover: async () => {
      if (failed) throw new Error("SSO authorization required")
      return discovery()
    } } }).start()
    actor.send({ type: "DISCOVER" })
    await waitFor(actor, (state) => state.matches("failed"))
    expect(actor.getSnapshot().context.discoveryError).toBe("SSO authorization required")
    expect(actor.getSnapshot().context.revision).toBe(1)
    actor.send({ type: "DISCOVER" })
    await waitFor(actor, (state) => state.matches("failed"))
    expect(actor.getSnapshot().context.revision).toBe(2)
    failed = false
    actor.send({ type: "DISCOVER" })
    await waitFor(actor, (state) => state.matches("ready"))
    expect(actor.getSnapshot().context).toMatchObject({ teamId: null, queue: "reviews", discoveryError: null })
    actor.send({ type: "TEAM", teamId: "forged" })
    expect(actor.getSnapshot().context.teamId).toBeNull()
    actor.stop()
  })
})
