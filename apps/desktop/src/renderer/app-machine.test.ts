import {
  ProviderCatalog as ProviderCatalogSchema,
  type DetectedResourceCandidate,
  type ProviderCatalog,
  type ProviderConnection,
  type ResourceDetectionResult,
  type ResourceImportResult,
  type Session,
} from "@jingler/core";
import { Schema } from "effect";
import { describe, expect, it, vi } from "vitest";
import { createActor, fromCallback, fromPromise, waitFor } from "xstate";
import {
  appMachine,
  type ChosenRepositoryDirectory,
  type InitialData,
  type ProviderAuthInput,
} from "./app-machine.js";

vi.mock("./rpc-client.js", () => ({ rpc: {} }));

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
          confirmedBillingRoute: "subscription",
        },
        createdAt: "2026-08-10T08:00:00.000Z",
        updatedAt: "2026-08-10T08:00:00.000Z",
      },
      models: [
        {
          providerId: "anthropic",
          id: "anthropic/claude-test",
          label: "Claude Test",
          capabilities: {
            contextWindow: 200_000,
            reasoning: [],
            vision: false,
          },
          verification: "certified",
          selectable: true,
          certificationKey: "certification-1",
        },
      ],
    },
  ],
  refreshedAt: "2026-08-10T08:00:00.000Z",
  stale: false,
});

const emptyDetection: ResourceDetectionResult = { candidates: [], skipped: [] };
const emptyImport: ResourceImportResult = { imported: [], skipped: [] };
const authenticatedCatalogWithoutModels = Schema.decodeSync(
  ProviderCatalogSchema,
)({
  ...providerCatalog,
  connections: providerCatalog.connections.map(({ connection }) => ({
    connection,
    models: [],
  })),
});

const disconnectedCatalog = Schema.decodeSync(ProviderCatalogSchema)({
  ...providerCatalog,
  connections: providerCatalog.connections.map(({ connection }) => ({
    connection: {
      ...connection,
      status: "disconnected",
      subscription: {
        ...connection.subscription,
        entitlement: "unavailable",
        confirmedBillingRoute: null,
      },
    },
    models: [],
  })),
});

const unconfigured = () =>
  appMachine.provide({
    actors: {
      initialLoad: fromPromise<InitialData>(async () => ({
        configured: false,
        providerReady: false,
        reposDir: null,
        repos: [],
        sessions: [],
        providerCatalog,
      })),
      chooseDir: fromPromise<ChosenRepositoryDirectory | null>(async () => ({
        reposDir: "/repos",
        repos: [],
      })),
      loadSessions: fromPromise<ReadonlyArray<Session>>(async () => []),
      loadProviderCatalog: fromPromise<ProviderCatalog>(
        async () => providerCatalog,
      ),
      watchProviderLoginEvents: fromCallback(() => () => undefined),
      connectProvider: fromPromise<ProviderConnection, ProviderAuthInput>(
        async () => providerCatalog.connections[0]!.connection,
      ),
      completeProviderSetup: fromPromise<void>(async () => undefined),
      detectResources: fromPromise<ResourceDetectionResult>(
        async () => emptyDetection,
      ),
      importResources: fromPromise<
        ResourceImportResult,
        ReadonlyArray<DetectedResourceCandidate>
      >(async () => emptyImport),
    },
  });

const reachProvider = async (
  actor: ReturnType<typeof createActor<typeof appMachine>>,
) => {
  await waitFor(actor, (snapshot) =>
    snapshot.matches({ setup: { workspace: "idle" } }),
  );
  actor.send({ type: "CHOOSE" });
  await waitFor(actor, (snapshot) => snapshot.context.reposDir === "/repos");
  actor.send({ type: "CONTINUE" });
  actor.send({ type: "SKIP_GITHUB" });
  await waitFor(actor, (snapshot) =>
    snapshot.matches({ setup: { provider: "idle" } }),
  );
};

describe("appMachine first-run coordination", () => {
  it("routes a configured workspace without a selectable default to provider recovery", async () => {
    const recovery = unconfigured().provide({
      actors: {
        initialLoad: fromPromise<InitialData>(async () => ({
          configured: true,
          providerReady: false,
          reposDir: "/repos",
          repos: [],
          sessions: [],
          providerCatalog,
        })),
      },
    });
    const actor = createActor(recovery).start();

    await waitFor(actor, (snapshot) =>
      snapshot.matches({ setup: { provider: "idle" } }),
    );
    expect(actor.getSnapshot().context.reposDir).toBe("/repos");
    expect(actor.getSnapshot().matches("ready")).toBe(false);
    actor.stop();
  });

  it("adds a newly-published continuation session to the ready session list", async () => {
    const configured = appMachine.provide({
      actors: {
        initialLoad: fromPromise<InitialData>(async () => ({
          configured: true,
          providerReady: true,
          reposDir: "/repos",
          repos: [],
          sessions: [],
          providerCatalog,
        })),
      },
    });
    const actor = createActor(configured).start();
    await waitFor(actor, (snapshot) => snapshot.matches("ready"));
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
      activeChatId: "chat-1",
    } as Session;

    actor.send({ type: "SESSION_UPDATED", session: continuation });

    expect(actor.getSnapshot().context.sessions).toContainEqual(continuation);
    actor.stop();
  });

  it("coordinates workspace, GitHub, provider auth, resources, and startup", async () => {
    const actor = createActor(unconfigured()).start();
    await reachProvider(actor);
    actor.send({ type: "CONTINUE_PROVIDER" });
    await waitFor(actor, (snapshot) =>
      snapshot.matches({ setup: { resources: "reviewing" } }),
    );
    actor.send({ type: "SKIP_RESOURCES" });
    await waitFor(actor, (snapshot) => snapshot.matches("ready"));
    actor.stop();
  });

  it("continues after authentication without requiring model discovery or certification", async () => {
    const completeProviderSetup = vi.fn(async () => undefined);
    const machine = unconfigured().provide({
      actors: {
        initialLoad: fromPromise<InitialData>(async () => ({
          configured: false,
          providerReady: false,
          reposDir: null,
          repos: [],
          sessions: [],
          providerCatalog: authenticatedCatalogWithoutModels,
        })),
        loadProviderCatalog: fromPromise<ProviderCatalog>(
          async () => authenticatedCatalogWithoutModels,
        ),
        completeProviderSetup: fromPromise<void>(completeProviderSetup),
      },
    });
    const actor = createActor(machine).start();
    await reachProvider(actor);

    actor.send({ type: "CONTINUE_PROVIDER" });

    await waitFor(actor, (snapshot) =>
      snapshot.matches({ setup: { resources: "reviewing" } }),
    );
    expect(completeProviderSetup).toHaveBeenCalledOnce();
    actor.stop();
  });

  it("requires authentication to continue but allows setup to be skipped", async () => {
    const machine = unconfigured().provide({
      actors: {
        initialLoad: fromPromise<InitialData>(async () => ({
          configured: false,
          providerReady: false,
          reposDir: null,
          repos: [],
          sessions: [],
          providerCatalog: disconnectedCatalog,
        })),
        loadProviderCatalog: fromPromise<ProviderCatalog>(
          async () => disconnectedCatalog,
        ),
      },
    });
    const actor = createActor(machine).start();
    await reachProvider(actor);

    actor.send({ type: "CONTINUE_PROVIDER" });
    expect(actor.getSnapshot().matches({ setup: { provider: "idle" } })).toBe(
      true,
    );
    actor.send({ type: "SKIP_PROVIDER" });
    await waitFor(actor, (snapshot) =>
      snapshot.matches({ setup: { resources: "reviewing" } }),
    );
    actor.stop();
  });

  it("retries authentication without retaining the submitted secret", async () => {
    const machine = unconfigured().provide({
      actors: {
        connectProvider: fromPromise<ProviderConnection, ProviderAuthInput>(
          async () => {
            throw new Error("Token rejected");
          },
        ),
      },
    });
    const actor = createActor(machine).start();
    await reachProvider(actor);
    actor.send({
      type: "CONNECT_CLAUDE",
      kind: "claude-setup-token",
      id: "connection-1",
      token: "short-lived-secret",
      targetId: "local",
    });
    await waitFor(actor, (snapshot) =>
      snapshot.matches({ setup: { provider: "authFailed" } }),
    );

    expect(JSON.stringify(actor.getSnapshot().context)).not.toContain(
      "short-lived-secret",
    );
    actor.send({ type: "RETRY_AUTH" });
    expect(actor.getSnapshot().matches({ setup: { provider: "idle" } })).toBe(
      true,
    );
    actor.stop();
  });

  it("retries provider setup persistence independently from authentication", async () => {
    let attempts = 0;
    const machine = unconfigured().provide({
      actors: {
        completeProviderSetup: fromPromise<void>(async () => {
          attempts += 1;
          if (attempts === 1) throw new Error("Config unavailable");
        }),
      },
    });
    const actor = createActor(machine).start();
    await reachProvider(actor);
    actor.send({ type: "CONTINUE_PROVIDER" });
    await waitFor(actor, (snapshot) =>
      snapshot.matches({ setup: { provider: "completionFailed" } }),
    );
    actor.send({ type: "RETRY_PROVIDER" });
    await waitFor(actor, (snapshot) =>
      snapshot.matches({ setup: { resources: "reviewing" } }),
    );
    expect(attempts).toBe(2);
    actor.stop();
  });

  it("skips resource import without mutating detected candidates", async () => {
    const importSpy = vi.fn(async () => emptyImport);
    const machine = unconfigured().provide({
      actors: {
        importResources: fromPromise<
          ResourceImportResult,
          ReadonlyArray<DetectedResourceCandidate>
        >(importSpy),
      },
    });
    const actor = createActor(machine).start();
    await reachProvider(actor);
    actor.send({ type: "CONTINUE_PROVIDER" });
    await waitFor(actor, (snapshot) =>
      snapshot.matches({ setup: { resources: "reviewing" } }),
    );
    actor.send({ type: "SKIP_RESOURCES" });
    await waitFor(actor, (snapshot) => snapshot.matches("ready"));
    expect(importSpy).not.toHaveBeenCalled();
    actor.stop();
  });

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
      activeChatId: "chat-1",
    } as Session;
    const configured = appMachine.provide({
      actors: {
        initialLoad: fromPromise<InitialData>(async () => ({
          configured: true,
          providerReady: true,
          reposDir: "/repos",
          repos: [],
          sessions: [session],
          providerCatalog,
        })),
      },
    });
    const actor = createActor(configured).start();
    await waitFor(actor, (snapshot) => snapshot.matches("ready"));

    actor.send({
      type: "SESSION_PUBLISH_UPDATED",
      sessionId: session.id,
      checkpoint: {
        step: "complete",
        completed: ["inspecting", "verifying-branch", "pushing", "linking"],
        branch: session.branch,
        prNumber: 42,
        updatedAt: "2026-08-05T08:01:00.000Z",
      },
    });

    expect(actor.getSnapshot().context.sessions[0]).toMatchObject({
      title: "Current title",
      prNumber: 42,
      publish: { step: "complete", prNumber: 42 },
    });
    actor.stop();
  });

  it("resumes into the app when the separate GitHub machine reports connected", async () => {
    const actor = createActor(unconfigured()).start();
    await waitFor(actor, (snapshot) =>
      snapshot.matches({ setup: { workspace: "idle" } }),
    );
    actor.send({ type: "CHOOSE" });
    await waitFor(actor, (snapshot) => snapshot.context.reposDir === "/repos");
    actor.send({ type: "CONTINUE" });
    actor.send({ type: "GITHUB_CONNECTED" });
    await waitFor(actor, (snapshot) =>
      snapshot.matches({ setup: { provider: "idle" } }),
    );
    actor.send({ type: "CONTINUE_PROVIDER" });
    await waitFor(actor, (snapshot) =>
      snapshot.matches({ setup: { resources: "reviewing" } }),
    );
    actor.send({ type: "SKIP_RESOURCES" });
    await waitFor(actor, (snapshot) => snapshot.matches("ready"));
    actor.stop();
  });
});
