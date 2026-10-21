import {
  ProviderCatalog as ProviderCatalogSchema,
  type ProviderCatalog,
  type ProviderConnection,
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

  it.each(["ready-first", "running-first"])("preserves the latest durable lifecycle with %s replies while accepting metadata", async (order) => {
    const configured = appMachine.provide({
      actors: {
        initialLoad: fromPromise<InitialData>(async () => ({
          configured: true, providerReady: true, reposDir: "/repos",
          repos: [], sessions: [], providerCatalog,
        })),
      },
    });
    const actor = createActor(configured).start();
    await waitFor(actor, (snapshot) => snapshot.matches("ready"));
    const running: Session = {
      id: "retry", repo: "widget", branch: "main", title: "Preparing",
      status: "idle", diff: { added: 0, removed: 0 }, prNumber: null,
      costUsd: 0, tokens: 0, chats: [], activeChatId: "chat-1",
      updatedAt: "2026-08-08T08:00:03.000Z",
      workspaceLifecycle: { status: "setup-running", updatedAt: "2026-08-08T08:00:01.000Z" },
    };
    const ready: Session = {
      ...running, title: "Ready", updatedAt: "2026-08-08T08:00:02.000Z",
      workspaceLifecycle: { status: "ready", updatedAt: "2026-08-08T08:00:02.000Z" },
    };
    const replies = order === "ready-first" ? [ready, running] : [running, ready];
    for (const session of replies) actor.send({ type: "SESSION_UPDATED", session });
    expect(actor.getSnapshot().context.sessions).toEqual([{
      ...replies[1], workspaceLifecycle: ready.workspaceLifecycle,
    }]);
    // An unrelated session must never inherit this session's lifecycle.
    actor.send({ type: "SESSION_UPDATED", session: { ...running, id: "other" } });
    expect(actor.getSnapshot().context.sessions[1]?.workspaceLifecycle).toEqual(running.workspaceLifecycle);
    // Legacy replies omit lifecycle; they still carry useful metadata.
    const { workspaceLifecycle: _lifecycle, ...legacy } = running;
    actor.send({ type: "SESSION_UPDATED", session: { ...legacy, title: "Retitled" } });
    expect(actor.getSnapshot().context.sessions[0]).toEqual({
      ...legacy, title: "Retitled", workspaceLifecycle: ready.workspaceLifecycle,
    });
    // Newer retries and failures are authoritative, even after ready.
    for (const [status, second] of [["setup-running", "04"], ["setup-failed", "05"], ["ready", "06"]] as const) {
      const session: Session = { ...running, workspaceLifecycle: {
        status, updatedAt: `2026-08-08T08:00:${second}.000Z`,
      } };
      actor.send({ type: "SESSION_UPDATED", session });
      expect(actor.getSnapshot().context.sessions[0]).toEqual(session);
    }
    const archived: Session = { ...ready, archived: true, archiveReason: "closed", archivedAt: ready.updatedAt,
      workspaceLifecycle: { status: "cleanup-failed", updatedAt: "2026-08-08T08:00:07.000Z", error: "failed", output: "history" } };
    actor.send({ type: "SESSION_UPDATED", session: archived });
    actor.send({ type: "SESSION_UPDATED", session: { ...running, title: "Delayed retitle", status: "idle" } });
    expect(actor.getSnapshot().context.sessions[0]).toMatchObject({ title: "Delayed retitle", status: "idle", archived: true, archiveReason: "closed", archivedAt: archived.archivedAt, workspaceLifecycle: archived.workspaceLifecycle });
    const restored: Session = { ...ready, archived: false, workspaceLifecycle: { ...archived.workspaceLifecycle!, updatedAt: "2026-08-08T08:00:07.001Z" } };
    actor.send({ type: "SESSION_UPDATED", session: restored });
    actor.send({ type: "SESSION_UPDATED", session: archived });
    expect(actor.getSnapshot().context.sessions[0]).toMatchObject({ archived: false, workspaceLifecycle: restored.workspaceLifecycle });
    expect(actor.getSnapshot().context.sessions[0]?.archiveReason).toBeUndefined();
    expect(actor.getSnapshot().context.sessions[0]?.archivedAt).toBeUndefined();
    actor.stop();
  });

  // Acceptance: onboarding completes with no resources step — CONTINUE_PROVIDER
  // lands on importSessions directly, never on a "resources" state.
  it("coordinates workspace, GitHub, provider auth, and startup with no resources step", async () => {
    const actor = createActor(unconfigured()).start();
    await reachProvider(actor);
    actor.send({ type: "CONTINUE_PROVIDER" });
    await waitFor(actor, (snapshot) =>
      snapshot.matches({ setup: "importSessions" }),
    );
    expect(actor.getSnapshot().matches({ setup: "resources" } as never)).toBe(false);
    actor.send({ type: "SKIP_IMPORT_SESSIONS" });
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
      snapshot.matches({ setup: "importSessions" }),
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
      snapshot.matches({ setup: "importSessions" }),
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
    expect(actor.getSnapshot().context.providerPendingAuthKind).toBe(
      "claude-setup-token",
    );
    await waitFor(actor, (snapshot) =>
      snapshot.matches({ setup: { provider: "authFailed" } }),
    );

    expect(JSON.stringify(actor.getSnapshot().context)).not.toContain(
      "short-lived-secret",
    );
    expect(actor.getSnapshot().context.providerPendingAuthKind).toBeNull();
    actor.send({ type: "RETRY_AUTH" });
    expect(actor.getSnapshot().matches({ setup: { provider: "idle" } })).toBe(
      true,
    );
    actor.stop();
  });

  it("recovers from a failed provider catalog load via RETRY_PROVIDER", async () => {
    let loads = 0;
    const machine = unconfigured().provide({
      actors: {
        loadProviderCatalog: fromPromise<ProviderCatalog>(async () => {
          loads += 1;
          if (loads === 1) throw new Error("Catalog unavailable");
          return providerCatalog;
        }),
      },
    });
    const actor = createActor(machine).start();
    await waitFor(actor, (s) => s.matches({ setup: "workspace" }));
    actor.send({ type: "CHOOSE" });
    await waitFor(actor, (s) => s.context.reposDir === "/repos");
    actor.send({ type: "CONTINUE" });
    actor.send({ type: "SKIP_GITHUB" });
    await waitFor(actor, (s) => s.matches({ setup: { provider: "loadFailed" } }));
    expect(actor.getSnapshot().context.error).toBe("Catalog unavailable");
    actor.send({ type: "RETRY_PROVIDER" });
    await waitFor(actor, (s) => s.matches({ setup: { provider: "idle" } }));
    expect(actor.getSnapshot().context.error).toBeNull();
    actor.stop();
  });

  it("blocks CONTINUE_PROVIDER while no provider is connected", async () => {
    const machine = unconfigured().provide({
      actors: {
        loadProviderCatalog: fromPromise<ProviderCatalog>(async () => disconnectedCatalog),
      },
    });
    const actor = createActor(machine).start();
    await reachProvider(actor);
    actor.send({ type: "CONTINUE_PROVIDER" });
    expect(actor.getSnapshot().matches({ setup: { provider: "idle" } })).toBe(true);
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
      snapshot.matches({ setup: "importSessions" }),
    );
    expect(attempts).toBe(2);
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
      snapshot.matches({ setup: "importSessions" }),
    );
    actor.send({ type: "SKIP_IMPORT_SESSIONS" });
    await waitFor(actor, (snapshot) => snapshot.matches("ready"));
    actor.stop();
  });

  it("keeps onboarding on step 1 when the folder scan fails, then recovers on retry", async () => {
    let attempts = 0;
    const flaky = unconfigured().provide({
      actors: {
        chooseDir: fromPromise<ChosenRepositoryDirectory | null>(async () => {
          attempts += 1;
          if (attempts === 1) throw new Error("EACCES: permission denied");
          return { reposDir: "/repos", repos: [] };
        }),
      },
    });
    const actor = createActor(flaky).start();
    await waitFor(actor, (snapshot) =>
      snapshot.matches({ setup: { workspace: "idle" } }),
    );
    actor.send({ type: "CHOOSE" });
    await waitFor(
      actor,
      (snapshot) =>
        snapshot.matches({ setup: { workspace: "idle" } }) &&
        snapshot.context.error !== null,
    );
    expect(actor.getSnapshot().context.error).toContain("permission denied");
    expect(actor.getSnapshot().matches("failure")).toBe(false);

    actor.send({ type: "CHOOSE" });
    await waitFor(actor, (snapshot) => snapshot.context.reposDir === "/repos");
    expect(actor.getSnapshot().context.error).toBeNull();
    actor.stop();
  });
});

describe("appMachine onboarding step 1 project selection", () => {
  const repo = (name: string) => ({
    name,
    path: `/repos/${name}`,
    defaultBranch: "main",
    currentBranch: "main",
    remoteUrl: null,
    githubSlug: null,
  });

  it("registers exactly the ticked repositories, then advances to GitHub", async () => {
    const registered: string[] = [];
    const machine = unconfigured().provide({
      actors: {
        chooseDir: fromPromise<ChosenRepositoryDirectory | null>(async () => ({
          reposDir: "/repos",
          repos: [repo("a"), repo("b"), repo("c")],
        })),
        registerProjects: fromPromise<void, ReadonlyArray<string>>(
          async ({ input }) => {
            registered.push(...input);
          },
        ),
      },
    });
    const actor = createActor(machine).start();
    await waitFor(actor, (snapshot) =>
      snapshot.matches({ setup: { workspace: "idle" } }),
    );
    actor.send({ type: "CHOOSE" });
    await waitFor(actor, (snapshot) => snapshot.context.reposDir === "/repos");
    actor.send({ type: "TOGGLE_REPO", path: "/repos/a" });
    actor.send({ type: "TOGGLE_REPO", path: "/repos/b" });
    actor.send({ type: "TOGGLE_REPO", path: "/repos/c" });
    actor.send({ type: "TOGGLE_REPO", path: "/repos/c" });
    actor.send({ type: "ADD_PROJECTS" });
    await waitFor(actor, (snapshot) => snapshot.matches({ setup: "github" }));
    expect(registered).toEqual(["/repos/a", "/repos/b"]);
    actor.stop();
  });

  it("toggles all repositories and ignores ADD_PROJECTS with nothing ticked", async () => {
    const machine = unconfigured().provide({
      actors: {
        chooseDir: fromPromise<ChosenRepositoryDirectory | null>(async () => ({
          reposDir: "/repos",
          repos: [repo("a"), repo("b")],
        })),
      },
    });
    const actor = createActor(machine).start();
    await waitFor(actor, (snapshot) =>
      snapshot.matches({ setup: { workspace: "idle" } }),
    );
    actor.send({ type: "CHOOSE" });
    await waitFor(actor, (snapshot) => snapshot.context.reposDir === "/repos");
    actor.send({ type: "ADD_PROJECTS" });
    expect(actor.getSnapshot().matches({ setup: { workspace: "idle" } })).toBe(true);
    actor.send({ type: "TOGGLE_ALL_REPOS" });
    expect(actor.getSnapshot().context.selectedRepoPaths).toEqual(["/repos/a", "/repos/b"]);
    actor.send({ type: "TOGGLE_ALL_REPOS" });
    expect(actor.getSnapshot().context.selectedRepoPaths).toEqual([]);
    actor.stop();
  });

  it("stays on step 1 with an error when registration fails", async () => {
    const machine = unconfigured().provide({
      actors: {
        chooseDir: fromPromise<ChosenRepositoryDirectory | null>(async () => ({
          reposDir: "/repos",
          repos: [repo("a")],
        })),
        registerProjects: fromPromise<void, ReadonlyArray<string>>(async () => {
          throw new Error("disk full");
        }),
      },
    });
    const actor = createActor(machine).start();
    await waitFor(actor, (snapshot) =>
      snapshot.matches({ setup: { workspace: "idle" } }),
    );
    actor.send({ type: "CHOOSE" });
    await waitFor(actor, (snapshot) => snapshot.context.reposDir === "/repos");
    actor.send({ type: "TOGGLE_REPO", path: "/repos/a" });
    actor.send({ type: "ADD_PROJECTS" });
    await waitFor(
      actor,
      (snapshot) =>
        snapshot.matches({ setup: { workspace: "idle" } }) &&
        snapshot.context.error !== null,
    );
    expect(actor.getSnapshot().context.error).toContain("disk full");
    actor.stop();
  });
});

describe("appMachine boot failure retry", () => {
  it("retries from failure back to loading", async () => {
    const machine = appMachine.provide({
      actors: {
        initialLoad: fromPromise<InitialData>(async () => {
          throw new Error("Network unavailable");
        }),
      },
    });
    const actor = createActor(machine).start();

    await waitFor(actor, (snapshot) => snapshot.matches("failure"));
    expect(actor.getSnapshot().context.error).toBe("Network unavailable");

    actor.send({ type: "RETRY" });

    await waitFor(actor, (snapshot) => snapshot.matches("loading"));
    actor.stop();
  });

  it("succeeds after retry from a transient boot failure", async () => {
    let attempts = 0;
    const machine = appMachine.provide({
      actors: {
        initialLoad: fromPromise<InitialData>(async () => {
          attempts += 1;
          if (attempts === 1) throw new Error("Transient failure");
          return {
            configured: true,
            providerReady: true,
            reposDir: "/repos",
            repos: [],
            sessions: [],
            providerCatalog,
          };
        }),
      },
    });
    const actor = createActor(machine).start();

    await waitFor(actor, (snapshot) => snapshot.matches("failure"));
    expect(actor.getSnapshot().context.error).toBe("Transient failure");

    actor.send({ type: "RETRY" });

    await waitFor(actor, (snapshot) => snapshot.matches("ready"));
    expect(attempts).toBe(2);
    actor.stop();
  });
});
