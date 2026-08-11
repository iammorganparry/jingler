import {
  ProviderCatalog as ProviderCatalogSchema,
  type DetectedResourceCandidate,
  type ProviderCatalog,
  type ProviderConnection,
  type ProviderConnectionId,
  type ProviderId,
  type ProviderModelId,
  type ResourceDetectionResult,
  type ResourceImportResult,
  type Session
} from "@jingler/core"
import { Schema } from "effect"
import { describe, expect, it, vi } from "vitest"
import { createActor, fromCallback, fromPromise, waitFor } from "xstate"
import {
  appMachine,
  type ChosenRepositoryDirectory,
  type InitialData,
  type ProviderAuthInput,
  type SelectedProviderModel
} from "./app-machine.js"

vi.mock("./rpc-client.js", () => ({ rpc: {} }))

const providerCatalog = Schema.decodeSync(ProviderCatalogSchema)({
  connections: [
    {
      connection: {
        id: "connection-1",
        providerId: "anthropic",
        authKind: "claude-setup-token",
        account: null,
        targetId: "local",
        status: "authenticated",
        subscription: {
          entitlement: "active",
          planLabel: "Max",
          expiresAt: null,
          quotaLabel: null,
          rateLimitLabel: null,
          confirmedBillingRoute: "subscription"
        },
        createdAt: "2026-08-10T08:00:00.000Z",
        updatedAt: "2026-08-10T08:00:00.000Z"
      },
      models: [
        {
          providerId: "anthropic",
          id: "anthropic/claude-test",
          label: "Claude Test",
          capabilities: { contextWindow: 200_000, reasoning: [], vision: false },
          verification: "certified",
          selectable: true,
          certificationKey: "certification-1"
        }
      ]
    }
  ],
  refreshedAt: "2026-08-10T08:00:00.000Z",
  stale: false
})

const emptyDetection: ResourceDetectionResult = { candidates: [], skipped: [] }
const emptyImport: ResourceImportResult = { imported: [], skipped: [] }
const selection: SelectedProviderModel = {
  connectionId: providerCatalog.connections[0]!.connection.id,
  providerId: providerCatalog.connections[0]!.connection.providerId,
  modelId: providerCatalog.connections[0]!.models[0]!.id
}

const unconfigured = () =>
  appMachine.provide({
    actors: {
      initialLoad: fromPromise<InitialData>(async () => ({
        configured: false,
        clis: [],
        reposDir: null,
        repos: [],
        sessions: [],
        providerCatalog
      })),
      chooseDir: fromPromise<ChosenRepositoryDirectory | null>(async () => ({
        reposDir: "/repos",
        repos: []
      })),
      loadSessions: fromPromise<ReadonlyArray<Session>>(async () => []),
      loadProviderCatalog: fromPromise<ProviderCatalog>(async () => providerCatalog),
      watchProviderLoginEvents: fromCallback(() => () => undefined),
      connectProvider: fromPromise<ProviderConnection, ProviderAuthInput>(async () =>
        providerCatalog.connections[0]!.connection
      ),
      verifyProviderModel: fromPromise<ProviderCatalog, SelectedProviderModel>(async () =>
        providerCatalog
      ),
      detectResources: fromPromise<ResourceDetectionResult>(async () => emptyDetection),
      importResources: fromPromise<
        ResourceImportResult,
        ReadonlyArray<DetectedResourceCandidate>
      >(async () => emptyImport)
    }
  })

const reachProvider = async (actor: ReturnType<typeof createActor<typeof appMachine>>) => {
  await waitFor(actor, (snapshot) => snapshot.matches({ setup: { workspace: "idle" } }))
  actor.send({ type: "CHOOSE" })
  await waitFor(actor, (snapshot) => snapshot.context.reposDir === "/repos")
  actor.send({ type: "CONTINUE" })
  actor.send({ type: "SKIP_GITHUB" })
  await waitFor(actor, (snapshot) => snapshot.matches({ setup: { provider: "idle" } }))
}

describe("appMachine first-run coordination", () => {
  it("adds a newly-published continuation session to the ready session list", async () => {
    const configured = appMachine.provide({
      actors: {
        initialLoad: fromPromise<InitialData>(async () => ({
          configured: true,
          clis: [],
          reposDir: "/repos",
          repos: [],
          sessions: [],
          providerCatalog
        }))
      }
    })
    const actor = createActor(configured).start()
    await waitFor(actor, (snapshot) => snapshot.matches("ready"))
    const continuation = {
      id: "session-continuation",
      repo: "widget",
      branch: "main",
      title: "Local session continuation",
      status: "idle",
      diff: { added: 0, removed: 0 },
      prNumber: null,
      costUsd: 0,
      tokens: 0,
      updatedAt: "2026-08-08T08:00:00.000Z",
      chats: [],
      activeChatId: "chat-1"
    } as Session

    actor.send({ type: "SESSION_UPDATED", session: continuation })

    expect(actor.getSnapshot().context.sessions).toContainEqual(continuation)
    actor.stop()
  })

  it("coordinates workspace, GitHub, certified provider, resources, and startup", async () => {
    const actor = createActor(unconfigured()).start()
    await reachProvider(actor)
    actor.send({ type: "SELECT_MODEL", ...selection })
    await waitFor(actor, (snapshot) => snapshot.matches({ setup: { resources: "reviewing" } }))
    actor.send({ type: "SKIP_RESOURCES" })
    await waitFor(actor, (snapshot) => snapshot.matches("ready"))
    actor.stop()
  })

  it("does not start until a selectable provider model has been verified", async () => {
    const actor = createActor(unconfigured()).start()
    await reachProvider(actor)

    expect(actor.getSnapshot().matches({ setup: { provider: "idle" } })).toBe(true)
    expect(actor.getSnapshot().matches("starting")).toBe(false)
    actor.stop()
  })

  it("retries authentication without retaining the submitted secret", async () => {
    const machine = unconfigured().provide({
      actors: {
        connectProvider: fromPromise<ProviderConnection, ProviderAuthInput>(async () => {
          throw new Error("Token rejected")
        })
      }
    })
    const actor = createActor(machine).start()
    await reachProvider(actor)
    actor.send({
      type: "CONNECT_CLAUDE",
      kind: "claude-setup-token",
      id: "connection-1",
      token: "short-lived-secret",
      targetId: "local"
    })
    await waitFor(actor, (snapshot) => snapshot.matches({ setup: { provider: "authFailed" } }))

    expect(JSON.stringify(actor.getSnapshot().context)).not.toContain("short-lived-secret")
    actor.send({ type: "RETRY_AUTH" })
    expect(actor.getSnapshot().matches({ setup: { provider: "idle" } })).toBe(true)
    actor.stop()
  })

  it("retries model verification independently from authentication", async () => {
    let attempts = 0
    const machine = unconfigured().provide({
      actors: {
        verifyProviderModel: fromPromise<ProviderCatalog, SelectedProviderModel>(async () => {
          attempts += 1
          if (attempts === 1) throw new Error("Scenario failed")
          return providerCatalog
        })
      }
    })
    const actor = createActor(machine).start()
    await reachProvider(actor)
    actor.send({ type: "SELECT_MODEL", ...selection })
    await waitFor(actor, (snapshot) =>
      snapshot.matches({ setup: { provider: "verificationFailed" } })
    )
    actor.send({ type: "RETRY_VERIFICATION" })
    await waitFor(actor, (snapshot) => snapshot.matches({ setup: { resources: "reviewing" } }))
    expect(attempts).toBe(2)
    actor.stop()
  })

  it("skips resource import without mutating detected candidates", async () => {
    const importSpy = vi.fn(async () => emptyImport)
    const machine = unconfigured().provide({
      actors: {
        importResources: fromPromise<
          ResourceImportResult,
          ReadonlyArray<DetectedResourceCandidate>
        >(importSpy)
      }
    })
    const actor = createActor(machine).start()
    await reachProvider(actor)
    actor.send({ type: "SELECT_MODEL", ...selection })
    await waitFor(actor, (snapshot) => snapshot.matches({ setup: { resources: "reviewing" } }))
    actor.send({ type: "SKIP_RESOURCES" })
    await waitFor(actor, (snapshot) => snapshot.matches("ready"))
    expect(importSpy).not.toHaveBeenCalled()
    actor.stop()
  })

  it("merges authoritative publish checkpoints without replacing concurrent session fields", async () => {
    const session = {
      id: "session-1",
      repo: "acme/widget",
      branch: "feat/publish-progress",
      title: "Current title",
      status: "idle",
      diff: { added: 1, removed: 0 },
      prNumber: null,
      costUsd: 0,
      tokens: 0,
      updatedAt: "2026-08-05T08:00:00.000Z",
      chats: [],
      activeChatId: "chat-1"
    } as Session
    const configured = appMachine.provide({
      actors: {
        initialLoad: fromPromise<InitialData>(async () => ({
          configured: true,
          clis: [],
          reposDir: "/repos",
          repos: [],
          sessions: [session],
          providerCatalog
        }))
      }
    })
    const actor = createActor(configured).start()
    await waitFor(actor, (snapshot) => snapshot.matches("ready"))

    actor.send({
      type: "SESSION_PUBLISH_UPDATED",
      sessionId: session.id,
      checkpoint: {
        step: "complete",
        completed: ["inspecting", "verifying-branch", "pushing", "linking"],
        branch: session.branch,
        prNumber: 42,
        updatedAt: "2026-08-05T08:01:00.000Z"
      }
    })

    expect(actor.getSnapshot().context.sessions[0]).toMatchObject({
      title: "Current title",
      prNumber: 42,
      publish: { step: "complete", prNumber: 42 }
    })
    actor.stop()
  })

  it("resumes into the app when the separate GitHub machine reports connected", async () => {
    const actor = createActor(unconfigured()).start()
    await waitFor(actor, (snapshot) => snapshot.matches({ setup: { workspace: "idle" } }))
    actor.send({ type: "CHOOSE" })
    await waitFor(actor, (snapshot) => snapshot.context.reposDir === "/repos")
    actor.send({ type: "CONTINUE" })
    actor.send({ type: "GITHUB_CONNECTED" })
    await waitFor(actor, (snapshot) => snapshot.matches({ setup: { provider: "idle" } }))
    actor.send({ type: "SELECT_MODEL", ...selection })
    await waitFor(actor, (snapshot) => snapshot.matches({ setup: { resources: "reviewing" } }))
    actor.send({ type: "SKIP_RESOURCES" })
    await waitFor(actor, (snapshot) => snapshot.matches("ready"))
    actor.stop()
  })
})
