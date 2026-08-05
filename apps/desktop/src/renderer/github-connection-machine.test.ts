import type { GitHubAppConnectionStatus } from "@jingler/core"
import { describe, expect, it, vi } from "vitest"
import { createActor, fromPromise, waitFor } from "xstate"
import {
  connectionFromStatus,
  githubConnectionMachine,
  repositoryAccess
} from "./github-connection-machine.js"

vi.mock("./rpc-client.js", () => ({ rpc: {} }))

const installation = (
  over: Partial<GitHubAppConnectionStatus["installations"][number]> = {}
): GitHubAppConnectionStatus["installations"][number] => ({
  id: "101",
  account: { id: "201", login: "acme", type: "Organization", avatarUrl: null },
  repositorySelection: "all",
  permissions: { contents: "write", pull_requests: "write" },
  status: "active",
  suspendedAt: null,
  ...over
})

const status = (
  over: Partial<GitHubAppConnectionStatus> = {}
): GitHubAppConnectionStatus => ({
  enabled: true,
  connected: true,
  user: { id: "1", login: "octocat", name: "Octo Cat", avatarUrl: null },
  installations: [installation()],
  lastRefreshedAt: "2026-08-04T09:00:00.000Z",
  ...over
})

describe("connectionFromStatus", () => {
  it("distinguishes connected, partial access, suspension, and unavailable service", () => {
    expect(connectionFromStatus(status()).mode).toBe("connected")
    expect(
      connectionFromStatus(
        status({ installations: [installation({ repositorySelection: "selected" })] })
      ).mode
    ).toBe("partial-access")
    expect(
      connectionFromStatus(
        status({ installations: [installation({ status: "suspended", suspendedAt: "now" })] })
      ).mode
    ).toBe("suspended")
    expect(connectionFromStatus(status({ enabled: false })).mode).toBe("error")
  })
})

describe("repositoryAccess", () => {
  it("enables only repositories proven accessible by an active installation", () => {
    const connected = connectionFromStatus(status())
    expect(repositoryAccess(connected, "acme/widget").status).toBe("accessible")
    expect(repositoryAccess(connected, "outside/widget")).toMatchObject({
      status: "unavailable",
      reason: expect.stringContaining("outside")
    })
  })

  it("requires recovery for selected-only and suspended installations", () => {
    const partial = connectionFromStatus(
      status({ installations: [installation({ repositorySelection: "selected" })] })
    )
    expect(repositoryAccess(partial, "acme/widget").status).toBe("partial")
    const suspended = connectionFromStatus(
      status({ installations: [installation({ status: "suspended", suspendedAt: "now" })] })
    )
    expect(repositoryAccess(suspended, "acme/widget")).toMatchObject({
      status: "suspended",
      reason: expect.stringContaining("suspended")
    })
  })
})

describe("githubConnectionMachine", () => {
  it("opens installation, waits for its dedicated callback, then refreshes", async () => {
    const openInstall = vi.fn(async (): Promise<void> => {})
    const actor = createActor(
      githubConnectionMachine.provide({
        actors: {
          loadStatus: fromPromise(async () =>
            status({ connected: false, user: null, installations: [], lastRefreshedAt: null })
          ),
          openInstall: fromPromise<void>(openInstall),
          refreshStatus: fromPromise(async () => status()),
          disconnect: fromPromise<void>(async () => {})
        }
      })
    ).start()
    await waitFor(actor, (snapshot) => snapshot.matches("disconnected"))
    actor.send({ type: "CONNECT" })
    await waitFor(actor, (snapshot) => snapshot.matches("connecting"))
    expect(openInstall).toHaveBeenCalledOnce()

    actor.send({ type: "CALLBACK", ok: true, error: null })
    await waitFor(actor, (snapshot) => snapshot.matches("connected"))
    expect(actor.getSnapshot().context.connection.user?.login).toBe("octocat")
    actor.stop()
  })

  it("refreshes suspension and disconnects without changing BetterAuth", async () => {
    const suspended = status({
      installations: [installation({ status: "suspended", suspendedAt: "2026-08-04" })]
    })
    const disconnect = vi.fn(async (): Promise<void> => {})
    const actor = createActor(
      githubConnectionMachine.provide({
        actors: {
          loadStatus: fromPromise(async () => status()),
          openInstall: fromPromise<void>(async () => {}),
          refreshStatus: fromPromise(async () => suspended),
          disconnect: fromPromise<void>(disconnect)
        }
      })
    ).start()
    await waitFor(actor, (snapshot) => snapshot.matches("connected"))
    actor.send({ type: "REFRESH" })
    await waitFor(actor, (snapshot) => snapshot.matches("suspended"))
    actor.send({ type: "DISCONNECT" })
    await waitFor(actor, (snapshot) => snapshot.matches("disconnected"))
    expect(disconnect).toHaveBeenCalledOnce()
    actor.stop()
  })
})
