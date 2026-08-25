import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import {
  AppPaths,
  AgentResourceService,
  AssetService,
  AgentTurnDriver,
  ConfigService,
  GitHubAuth,
  GitHubApi,
  GitService,
  InMemorySecretStoreLive,
  MemoryService,
  makeAgentResourceService,
  ExplanationStore,
  PlanStore,
  PluginAuth,
  PluginHost,
  PluginRegistry,
  PluginSecretStore,
  PluginSecretStoreUnavailable,
  ProjectService,
  ReviewService,
  ReviewStore,
  SessionStore,
  TranscriptStore,
  TerminalService,
  WorkspaceService,
} from "@jingler/cli-adapters";
import type {
  AgentContext,
  AgentTurnDriverShape,
  AgentTurnSpec,
} from "@jingler/cli-adapters";
import type {
  Attachment,
  PlanDocument,
  PlanPrd,
  Session,
  StreamEvent,
  GitHubSessionRoute,
  GitHubRelayDelivery,
} from "@jingler/core";
import {
  GitError,
  GitHubApiError,
  DetectedResourceCandidate,
  ProviderModelId,
  planStageSemanticFingerprint,
} from "@jingler/core";
import {
  appPathsFor,
  fakeCommandExecutor,
} from "@jingler/cli-adapters/test-support";
import { NodeContext } from "@effect/platform-node";
import type { CommandExecutor } from "@effect/platform";
import {
  Chunk,
  Deferred,
  Effect,
  Either,
  Fiber,
  Layer,
  Logger,
  Schema,
  Stream,
} from "effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DialogService } from "./dialog.js";
import {
  adoptBranch,
  forkOntoBranch,
  transcriptForFork,
  chooseReposDir,
  awaitRelayAcknowledgement,
  explanationWatch,
  completeDurableGitHubFeedbackReplay,
  assetList,
  assetRead,
  assetWrite,
  configGet,
  createTerminal,
  memoryExport,
  githubDetectPr,
  githubSubmitReview,
  githubPr,
  mismatchedIssueProviderId,
  planAppendMessage,
  planDispatchExistingMessage,
  planSetThreadResolved,
  planUpdateMessageDelivery,
  reconcileRelaySessionRoutes,
  planWatch,
  reviewGet,
  reviewMarkRouted,
  reviewReconcile,
  reviewRun,
  removeRemoteSessionMirror,
  resolvePublishSessionBranch,
  selectContinuationRepository,
  setReasoning,
  setSessionPersistent,
  sessionCreationOptions,
  sessionDiff,
  skillsList,
  transcriptHasGitHubFeedback,
  uninstallPlugin,
  updateWebSearchAtomically,
  githubAckEvent,
  workspaceRevertFile,
  withoutAttachmentData,
  workspaceRevertLines,
} from "./rpc.js";

describe("session creation defaults", () => {
  const modelId = Schema.decodeUnknownSync(ProviderModelId)("anthropic/test");

  it("defaults every model to Auto and respects the saved preference", () => {
    expect(sessionCreationOptions({ modelId }).defaultMode).toBe("auto");
    expect(sessionCreationOptions({ modelId }, "ask").defaultMode).toBe("ask");
    expect(
      sessionCreationOptions({ modelId, mode: "accept-edits" }, "ask").defaultMode,
    ).toBe("accept-edits");
  });
});

describe("publish branch verification", () => {
  const session = (branch: string, semanticBranchPending = false): Session => ({
    id: "publish-session",
    repo: "jingler",
    branch,
    baseBranch: "main",
    title: "Publish session",
    status: "idle",
    diff: { added: 0, removed: 0 },
    prNumber: null,
    costUsd: 0,
    tokens: 0,
    updatedAt: "2026-08-10T00:00:00.000Z",
    worktreePath: "/tmp/publish-session",
    workspaceMode: "worktree",
    semanticBranchPending,
    semanticBranchProposal: { type: "fix", slug: "create-session-race" },
    chats: [{
      id: "publish-chat",
      title: null,
      createdAt: "2026-08-10T00:00:00.000Z",
      updatedAt: "2026-08-10T00:00:00.000Z",
    }],
    activeChatId: "publish-chat",
  });

  it("refreshes a session whose semantic branch persisted after publishing started", async () => {
    const refreshed = vi.fn(async () => session("fix/create-session-race"));

    await expect(
      resolvePublishSessionBranch(
        session("main", true),
        "fix/create-session-race",
        refreshed,
      ),
    ).resolves.toMatchObject({
      branch: "fix/create-session-race",
      session: {
        branch: "fix/create-session-race",
        semanticBranchPending: false,
      },
    });
    expect(refreshed).toHaveBeenCalledOnce();
  });

  it("still rejects a live branch that does not belong to the refreshed session", async () => {
    await expect(
      resolvePublishSessionBranch(
        session("main"),
        "fix/unrelated",
        async () => session("fix/create-session-race"),
      ),
    ).rejects.toThrow("The worktree branch changed to fix/unrelated");
  });
});

describe("issue provider identity", () => {
  it("accepts only data owned by the routed provider", () => {
    expect(mismatchedIssueProviderId("linear", ["linear", "linear"])).toBeUndefined();
    expect(mismatchedIssueProviderId("linear", ["linear", "github"])).toBe("github");
  });
});

describe("remote session environment lifecycle", () => {
  it("matches a continuation repository by GitHub identity before folder name", () => {
    const repository = selectContinuationRepository(
      { name: "renamed-source", githubSlug: "Acme/App" },
      [
        { name: "different", path: "/srv/app", defaultBranch: "main", githubSlug: "acme/app" },
        { name: "renamed-source", path: "/srv/wrong", defaultBranch: "main", githubSlug: "acme/other" },
      ],
    );
    expect(repository?.path).toBe("/srv/app");
  });

  it("falls back to repository name when neither machine has a GitHub slug", () => {
    const repository = selectContinuationRepository(
      { name: "Jingler", githubSlug: null },
      [{ name: "jingler", path: "/Users/buildbox/jingler", defaultBranch: "main", githubSlug: null }],
    );
    expect(repository?.path).toBe("/Users/buildbox/jingler");
  });

  it("removes a remote session mirror when the device is offline", async () => {
    let forgotten = false;
    await Effect.runPromise(removeRemoteSessionMirror(
      Effect.fail(new Error("device offline")),
      Effect.sync(() => { forgotten = true; }),
    ));
    expect(forgotten).toBe(true);
  });
});

describe("relay acknowledgement lifetime", () => {
  const delivery: GitHubRelayDelivery = {
    clientId: "client-1",
    cursor: 7,
    relaySessionId: "relay-session-1",
    sessionId: "session-1",
    chatId: "chat-1",
    event: {
      version: 1,
      deliveryId: "delivery-1",
      semanticKey: "comment-1",
      event: "issue_comment",
      action: "created",
      installationId: "installation-1",
      repository: {
        id: "repository-1",
        owner: "acme",
        name: "widgets",
        fullName: "acme/widgets",
      },
      pullRequest: null,
      actor: { id: "user-1", login: "octocat", type: "User" },
      feedback: null,
      actionable: true,
      occurredAt: "2026-08-05T12:00:00.000Z",
    },
  };

  it("keeps delivered feedback pending until the renderer acknowledges it", async () => {
    vi.useFakeTimers();
    let settled = false;
    const acknowledgement = awaitRelayAcknowledgement(
      delivery,
      () => undefined,
    ).finally(() => {
      settled = true;
    });

    // A legitimate acknowledgement can take a while (the target conversation
    // may be loading, or the instruction queued behind a running turn).
    await vi.advanceTimersByTimeAsync(4 * 60_000);
    expect(settled).toBe(false);

    await Effect.runPromise(githubAckEvent(delivery.clientId, delivery.cursor));
    await expect(acknowledgement).resolves.toBeUndefined();
    vi.useRealTimers();
  });

  it("rejects an acknowledgement nobody ever sends, so the stream replays instead of wedging", async () => {
    // An acknowledgement withheld forever freezes the connection's serial
    // delivery chain and the durable cursor: every later event for the session
    // is invisible until an app restart. The timeout converts that silent wedge
    // into a failed delivery, which closes the socket and replays the frame.
    vi.useFakeTimers();
    const acknowledgement = awaitRelayAcknowledgement(delivery, () => undefined);
    const outcome = acknowledgement.then(
      () => "resolved" as const,
      () => "rejected" as const,
    );
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    await expect(outcome).resolves.toBe("rejected");
    // The slot is released: a late renderer ack is a harmless no-op.
    await Effect.runPromise(githubAckEvent(delivery.clientId, delivery.cursor));
    vi.useRealTimers();
  });

  it("rejects immediately when the renderer answers with a retry outcome", async () => {
    const acknowledgement = awaitRelayAcknowledgement(delivery, () => undefined);
    const outcome = acknowledgement.then(
      () => "resolved" as const,
      () => "rejected" as const,
    );
    await Effect.runPromise(
      githubAckEvent(delivery.clientId, delivery.cursor, "retry"),
    );
    await expect(outcome).resolves.toBe("rejected");
  });
});

describe("transcriptHasGitHubFeedback", () => {
  const transcript = [
    {
      id: "user-1",
      role: "user" as const,
      parts: [{ _tag: "Text" as const, text: "Review feedback" }],
      streaming: false,
      createdAt: "2026-08-05T12:00:00.000Z",
      externalInstruction: {
        source: "github-feedback" as const,
        deliveryId: "delivery-1",
        semanticKey: "comment-1",
      },
    },
  ];

  it("recognizes replay by delivery id or semantic identity", () => {
    expect(
      transcriptHasGitHubFeedback(transcript, {
        deliveryId: "delivery-1",
        semanticKey: "different",
      }),
    ).toBe(true);
    expect(
      transcriptHasGitHubFeedback(transcript, {
        deliveryId: "different",
        semanticKey: "comment-1",
      }),
    ).toBe(true);
  });

  it("does not accept unrelated feedback", () => {
    expect(
      transcriptHasGitHubFeedback(transcript, {
        deliveryId: "delivery-2",
        semanticKey: "comment-2",
      }),
    ).toBe(false);
  });

  it("completes a pending replay from durable transcript identity without redispatch", async () => {
    const claim = vi.fn(async () => "pending" as const);
    const markDispatched = vi.fn(async () => true);
    await expect(
      completeDurableGitHubFeedbackReplay({
        transcript,
        event: { deliveryId: "delivery-1", semanticKey: "comment-1" },
        claim,
        markDispatched,
      }),
    ).resolves.toBe(true);
    expect(claim).toHaveBeenCalledOnce();
    expect(markDispatched).toHaveBeenCalledOnce();
  });
});

describe("reconcileRelaySessionRoutes", () => {
  const linkedSession = (patch: Partial<Session> = {}): Session =>
    ({
      id: "session-1",
      archived: false,
      prNumber: 42,
      githubInstallationId: "99",
      githubRepositoryId: "200",
      ...patch,
    }) as Session;

  const route = (
    patch: Partial<GitHubSessionRoute> = {},
  ): GitHubSessionRoute => ({
    sessionId: "session-1",
    relaySessionId: "opaque-relay-session-1",
    installationId: "99",
    repositoryId: "200",
    pullRequestNumber: 42,
    state: "active",
    updatedAt: "2026-08-05T12:00:00.000Z",
    ...patch,
  });

  it("archives an old identity before registering a changed session tuple", async () => {
    const operations: string[] = [];
    const previous = route({
      installationId: "98",
      repositoryId: "199",
      pullRequestNumber: 41,
    });
    const current = route();
    const result = await reconcileRelaySessionRoutes(
      async () => [linkedSession()],
      async () => [previous],
      async (candidate) => {
        operations.push(
          `archive:${candidate.installationId}:${candidate.repositoryId}:${candidate.pullRequestNumber}`,
        );
      },
      async () => {
        operations.push("register:99:200:42");
        return current;
      },
    );

    expect(operations).toEqual(["archive:98:199:41", "register:99:200:42"]);
    expect(result).toEqual([current]);
  });

  it("retains a matching route without mutation", async () => {
    const mutate = vi.fn();
    const current = route();
    await expect(
      reconcileRelaySessionRoutes(
        async () => [linkedSession()],
        async () => [current],
        mutate,
        mutate,
      ),
    ).resolves.toEqual([current]);
    expect(mutate).not.toHaveBeenCalled();
  });
});

/** Typed GitHub service fixture; tests override only the operations they exercise. */
const fakeGithubApi = (overrides: Record<string, unknown> = {}) =>
  Layer.succeed(GitHubApi, {
    prHeadSha: () => Effect.succeed("headsha"),
    prDiff: () => Effect.succeed("diff --git a/a.ts b/a.ts\n+x\n"),
    prReviewComments: () => Effect.void,
    ...overrides,
  } as never);

/**
 * The RPC handlers own the app's error-folding policy: a config read error must
 * look like "not configured" (→ first-run setup), and a cancelled folder picker
 * must be a no-op. We run the real ConfigService against a temp root and fake
 * only the native dialog, asserting the outcomes the renderer depends on.
 */
describe("RPC handlers", () => {
  let dir: string;
  let root: string;
  let base: Layer.Layer<ConfigService | AppPaths | NodeContext.NodeContext>;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "jingler-rpc-"));
    root = join(dir, "jingler");
    base = Layer.mergeAll(
      ConfigService.Default,
      Layer.succeed(AppPaths, appPathsFor(root)),
      NodeContext.layer,
    );
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const fakeDialog = (
    chosen: string | null,
    saveDestination: string | null = null,
  ) =>
    Layer.succeed(DialogService, {
      chooseDirectory: () => Effect.succeed(chosen),
      saveFile: () => Effect.succeed(saveDestination),
    });

  it("restores WebSearch configuration when its credential mutation fails", async () => {
    await Effect.runPromise(ConfigService.setWebSearch({
      setup: "skipped",
      provider: null,
    }).pipe(Effect.provide(base)));

    const exit = await Effect.runPromiseExit(updateWebSearchAtomically(
      { setup: "configured", provider: "exa" },
      Effect.fail("simulated credential failure"),
    ).pipe(Effect.provide(base)));
    expect(exit._tag).toBe("Failure");

    const config = await Effect.runPromise(ConfigService.get().pipe(Effect.provide(base)));
    expect(config?.webSearch).toEqual({ setup: "skipped", provider: null });
  });

  it("keeps a plugin installed when credential cleanup fails", async () => {
    const pluginDir = join(root, "plugins", "linear");
    mkdirSync(pluginDir, { recursive: true });
    const failingSecrets = Layer.succeed(PluginSecretStore, {
      get: () => Effect.succeed(null),
      set: () => Effect.void,
      clear: () => Effect.void,
      status: () => Effect.succeed(false),
      clearPlugin: () =>
        Effect.fail(
          new PluginSecretStoreUnavailable({ message: "simulated persistence failure" }),
        ),
    });

    const exit = await Effect.runPromiseExit(
      uninstallPlugin("linear").pipe(
        Effect.provide(PluginRegistry.Default),
        Effect.provide(PluginAuth.Default),
        Effect.provide(PluginHost.Default),
        Effect.provide(failingSecrets),
        Effect.provide(base),
      ),
    );

    expect(exit._tag).toBe("Failure");
    expect(String(exit)).toContain("plugin remains installed");
    expect(existsSync(pluginDir)).toBe(true);
  });

  it("Sessions.setPersistent returns and persists the updated session", async () => {
    const now = "2026-07-30T10:00:00.000Z";
    mkdirSync(root, { recursive: true });
    writeFileSync(
      join(root, "sessions.json"),
      JSON.stringify([
        {
          id: "s1",
          repo: "widget",
          branch: "chore/widget",
          title: "Widget",
          status: "idle",
          diff: { added: 0, removed: 0 },
          prNumber: null,
          costUsd: 0,
          tokens: 0,
          updatedAt: now,
          chats: [
            {
              id: "c1",
              title: null,
              createdAt: now,
              updatedAt: now,
            },
          ],
          activeChatId: "c1",
        },
      ]),
    );
    const layer = Layer.mergeAll(base, SessionStore.Default);

    const updated = await Effect.runPromise(
      setSessionPersistent("s1", true).pipe(Effect.provide(layer)),
    );
    const reloaded = await Effect.runPromise(
      SessionStore.get("s1").pipe(Effect.provide(layer)),
    );

    expect(updated.persistent).toBe(true);
    expect(reloaded.persistent).toBe(true);
  });

  describe("Sessions.adoptBranch / forkOntoBranch", () => {
    const now = "2026-08-19T10:00:00.000Z";
    const git = (cwd: string, args: ReadonlyArray<string>) =>
      execFileSync("git", args, { cwd, stdio: "ignore" });
    // The `s1` record for a direct session pinned to `main`, sharing `checkoutPath`.
    const writeDirectSessionRecord = (checkoutPath: string) => {
      mkdirSync(root, { recursive: true });
      writeFileSync(
        join(root, "sessions.json"),
        JSON.stringify([
          {
            id: "s1",
            repo: "widget",
            branch: "main",
            title: "Widget",
            status: "idle",
            connectionId: "anthropic-max",
            providerId: "anthropic",
            modelId: "anthropic/claude-sonnet-4-5",
            diff: { added: 0, removed: 0 },
            prNumber: null,
            costUsd: 0,
            tokens: 0,
            updatedAt: now,
            workspaceMode: "direct",
            worktreePath: checkoutPath,
            repoPath: checkoutPath,
            chats: [{ id: "c1", title: null, createdAt: now, updatedAt: now }],
            activeChatId: "c1",
          },
        ]),
      );
    };
    // A direct session sharing a checkout, pinned to `main` — the starting point
    // a BranchDrift recovery acts on once the checkout moves off `main`.
    const seedDriftedDirectSession = (checkoutPath: string) => {
      mkdirSync(checkoutPath, { recursive: true });
      git(checkoutPath, ["init"]);
      git(checkoutPath, ["checkout", "-b", "main"]);
      git(checkoutPath, ["config", "user.email", "t@example.com"]);
      git(checkoutPath, ["config", "user.name", "Test"]);
      writeFileSync(join(checkoutPath, "README.md"), "# repo\n");
      git(checkoutPath, ["add", "."]);
      git(checkoutPath, ["commit", "-m", "init"]);
      writeDirectSessionRecord(checkoutPath);
    };

    it("adoptBranch re-points a drifted session at the live branch and persists it", async () => {
      const checkoutPath = join(dir, "adopt-repo");
      seedDriftedDirectSession(checkoutPath);
      git(checkoutPath, ["checkout", "-b", "feature/other"]);
      const layer = Layer.mergeAll(base, SessionStore.Default);

      const updated = await Effect.runPromise(
        adoptBranch("s1").pipe(Effect.provide(layer)),
      );
      const reloaded = await Effect.runPromise(
        SessionStore.get("s1").pipe(Effect.provide(layer)),
      );

      expect(updated.branch).toBe("feature/other");
      expect(reloaded.branch).toBe("feature/other");
    });

    it("adoptBranch is a no-op when the checkout has not drifted", async () => {
      const checkoutPath = join(dir, "adopt-noop-repo");
      seedDriftedDirectSession(checkoutPath);
      const layer = Layer.mergeAll(base, SessionStore.Default);

      const updated = await Effect.runPromise(
        adoptBranch("s1").pipe(Effect.provide(layer)),
      );

      expect(updated.branch).toBe("main");
    });

    it("transcriptForFork keeps the work but strips the drift banner that led to the fork", () => {
      const now = "2026-08-19T11:00:00.000Z";
      const messages = [
        {
          id: "a1",
          role: "assistant" as const,
          streaming: false,
          createdAt: now,
          parts: [
            { _tag: "Tool" as const, tool: { id: "t1", name: "Bash", target: "git switch -c fix/x", status: "success" as const, meta: null, diff: null, preview: null } },
            { _tag: "BranchDrift" as const, sessionId: "s1", pinnedBranch: "main", liveBranch: "fix/x" },
          ],
        },
        {
          id: "a2",
          role: "assistant" as const,
          streaming: false,
          createdAt: now,
          parts: [
            { _tag: "BranchDrift" as const, sessionId: "s1", pinnedBranch: "main", liveBranch: "fix/x" },
          ],
        },
      ];

      const forked = transcriptForFork(messages);

      // The lone-banner message is dropped entirely; the work message keeps its
      // tool call but loses the banner.
      expect(forked).toHaveLength(1);
      expect(forked[0]?.parts.map((p) => p._tag)).toEqual(["Tool"]);
      expect(
        forked.some((m) => m.parts.some((p) => p._tag === "BranchDrift")),
      ).toBe(false);
    });

    it("forkOntoBranch forks a CLEAN isolated worktree from the drifted branch — commits kept, dirty tree dropped", async () => {
      const checkoutPath = join(dir, "fork-real-repo");
      seedDriftedDirectSession(checkoutPath);
      git(checkoutPath, ["checkout", "-b", "fix/linkedin"]);
      // A COMMITTED change on the drifted branch — the fork must keep it (proves
      // it forks from the branch tip, not the refreshed main base).
      writeFileSync(join(checkoutPath, "committed-on-fix.txt"), "fix work\n");
      git(checkoutPath, ["add", "."]);
      git(checkoutPath, ["commit", "-m", "fix work"]);
      // An UNCOMMITTED change — the developer's dirty tree that rode along on the
      // branch switch. The fork must NOT carry it (a fresh, clean worktree).
      writeFileSync(join(checkoutPath, "dirty-from-main.txt"), "not mine\n");

      const fork = await Effect.runPromise(
        forkOntoBranch("s1").pipe(
          Effect.provide(SessionStore.Default),
          Effect.provide(GitService.Default),
          Effect.provide(TranscriptStore.Default),
          Effect.provide(ProjectService.Default),
          Effect.provide(base),
        ),
      );

      // An ISOLATED worktree, not the shared checkout.
      expect(fork.workspaceMode).toBe("worktree");
      expect(fork.worktreePath).toBeDefined();
      expect(fork.worktreePath).not.toBe(checkoutPath);
      // Committed history on the drifted branch is preserved.
      expect(existsSync(join(fork.worktreePath!, "committed-on-fix.txt"))).toBe(
        true,
      );
      // The dirty working tree is NOT dragged in — the fork is clean.
      expect(existsSync(join(fork.worktreePath!, "dirty-from-main.txt"))).toBe(
        false,
      );
      // The source session stays pinned to its original branch.
      const source = await Effect.runPromise(
        SessionStore.get("s1").pipe(
          Effect.provide(SessionStore.Default),
          Effect.provide(base),
        ),
      );
      expect(source.branch).toBe("main");
    });

    it("forkOntoBranch fails with GitError when the checkout has not drifted", async () => {
      const checkoutPath = join(dir, "fork-nodrift-repo");
      seedDriftedDirectSession(checkoutPath);

      const exit = await Effect.runPromiseExit(
        forkOntoBranch("s1").pipe(
          Effect.provide(SessionStore.Default),
          Effect.provide(GitService.Default),
          Effect.provide(TranscriptStore.Default),
          Effect.provide(ProjectService.Default),
          Effect.provide(base),
        ),
      );

      expect(exit._tag).toBe("Failure");
      expect(String(exit)).toContain("has not drifted");
    });
  });

  it("routes revision-guarded thread mutations through the session plan worktree", async () => {
    const now = "2026-07-31T09:00:00.000Z";
    const worktreePath = join(dir, "worktree");
    mkdirSync(worktreePath, { recursive: true });
    mkdirSync(root, { recursive: true });
    writeFileSync(
      join(root, "sessions.json"),
      JSON.stringify([
        {
          id: "session-plan-thread",
          repo: "widget",
          branch: "chore/widget",
          title: "Widget",
          status: "idle",
          diff: { added: 0, removed: 0 },
          prNumber: null,
          costUsd: 0,
          tokens: 0,
          updatedAt: now,
          worktreePath,
          chats: [
            {
              id: "chat-plan-thread",
              title: null,
              createdAt: now,
              updatedAt: now,
            },
          ],
          activeChatId: "chat-plan-thread",
        },
      ]),
    );
    const services = Layer.mergeAll(
      SessionStore.Default,
      PlanStore.Default,
      ExplanationStore.Default,
    ).pipe(Layer.provideMerge(base));
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const explanationFiber = yield* explanationWatch("session-plan-thread").pipe(
          Stream.filter((document) => document !== null),
          Stream.take(1),
          Stream.runCollect,
          Effect.fork,
        );
        yield* Effect.sleep("25 millis");
        const explanation = yield* ExplanationStore.publish(
          worktreePath,
          "session-plan-thread",
          "chat-plan-thread",
          {
            title: "Thread flow",
            summary: "The explanation RPC watches the canonical artifact.",
            sections: [],
          },
        );
        const watchedExplanation = Chunk.toReadonlyArray(
          yield* Fiber.join(explanationFiber),
        )[0];
        const plan = yield* PlanStore.promoteDocument(worktreePath, {
          sessionId: "session-plan-thread",
          producingChatId: "chat-plan-thread",
          id: "plan-thread",
          plan: {
            title: "PRD: Thread RPC",
            sections: [],
            stages: [
              {
                id: "01",
                title: "Persist",
                intent: "Persist.",
                approach: [],
                files: [],
                diagrams: [],
                notes: [],
                acceptance: [
                  {
                    id: "01.1",
                    text: "It persists.",
                    status: "pending",
                    evidence: null,
                  },
                ],
              },
            ],
            annotations: [],
          },
          author: "agent",
        });
        const withThread = yield* PlanStore.addAnnotation(worktreePath, {
          planId: plan.id,
          baseRevision: plan.revision,
          stageId: "01",
          body: "Can you verify this?",
          author: "user",
        });
        const annotationId = withThread.plan.annotations[0]!.id;
        const watchedFiber = yield* planWatch("session-plan-thread", "chat-plan-thread").pipe(
          Stream.take(1),
          Stream.runCollect,
          Effect.fork,
        );
        yield* Effect.sleep("25 millis");
        const appended = yield* planAppendMessage({
          sessionId: "session-plan-thread",
          planId: plan.id,
          baseRevision: withThread.revision,
          annotationId,
          body: "Verified.",
          authorKind: "agent",
          authorId: "worker-storage",
          mentionedParticipantIds: ["operator"],
          deliveryState: "pending",
        });
        const watched = Chunk.toReadonlyArray(
          yield* Fiber.join(watchedFiber),
        )[0];
        const messageId = appended.plan.annotations[0]!.messages[1]!.id;
        const delivered = yield* planUpdateMessageDelivery({
          sessionId: "session-plan-thread",
          planId: plan.id,
          baseRevision: appended.revision,
          annotationId,
          messageId,
          deliveryState: "sent",
          author: "agent",
        });
        const resolved = yield* planSetThreadResolved({
          sessionId: "session-plan-thread",
          planId: plan.id,
          baseRevision: delivered.revision,
          annotationId,
          resolved: true,
          author: "user",
        });
        const stale = yield* Effect.either(
          planSetThreadResolved({
            sessionId: "session-plan-thread",
            planId: plan.id,
            baseRevision: appended.revision,
            annotationId,
            resolved: false,
            author: "user",
          }),
        );
        const retrySent = yield* Effect.either(
          planDispatchExistingMessage({
            sessionId: "session-plan-thread",
            planId: plan.id,
            baseRevision: resolved.revision,
            annotationId,
            messageId,
          }),
        );
        return {
          appended,
          delivered,
          resolved,
          stale,
          retrySent,
          watched,
          explanation,
          watchedExplanation,
        };
      }).pipe(Effect.provide(services)),
    );

    expect(result.appended.plan.annotations[0]?.messages[1]).toMatchObject({
      body: "Verified.",
      authorKind: "agent",
      authorId: "worker-storage",
      mentionedParticipantIds: ["operator"],
      deliveryState: "pending",
    });
    expect(
      result.delivered.plan.annotations[0]?.messages[1]?.deliveryState,
    ).toBe("sent");
    expect(result.resolved.plan.annotations[0]?.status).toBe("resolved");
    expect(result.explanation.revision).toBe(1);
    expect(result.watchedExplanation).toEqual(result.explanation);
    expect(result.watched?.revision).toBe(result.appended.revision);
    expect(result.watched?.plan.annotations[0]?.messages[1]?.body).toBe(
      "Verified.",
    );
    expect(Either.isLeft(result.stale)).toBe(true);
    expect(Either.isLeft(result.retrySent)).toBe(true);
    if (Either.isLeft(result.stale)) {
      expect(result.stale.left).toMatchObject({
        _tag: "PlanConflictError",
        latestRevision: result.resolved.revision,
      });
    }
  });

  describe("Agent.setReasoning", () => {
    it("logs a best-effort persistence failure", async () => {
      const messages: Array<{ level: string; text: string }> = [];
      const logger = Logger.make(({ logLevel, message }) => {
        const text = Array.isArray(message)
          ? message.map(String).join(" ")
          : String(message);
        messages.push({ level: logLevel.label, text });
      });
      const store = await Effect.runPromise(
        SessionStore.pipe(Effect.provide(SessionStore.Default)),
      );
      const failedStore = SessionStore.make({
        ...store,
        setReasoning: () =>
          Effect.fail(
            new GitError({ message: "test sessions.json write failed" }),
          ),
      });

      await Effect.runPromise(
        setReasoning("session-1", "chat-1", {
          enabled: true,
          effort: "high",
        }).pipe(
          Effect.provide(Layer.succeed(SessionStore, failedStore)),
          Effect.provide(Logger.replace(Logger.defaultLogger, logger)),
          Effect.provide(base),
        ),
      );

      expect(messages).toContainEqual({
        level: "WARN",
        text: "Failed to persist reasoning strength for session session-1: test sessions.json write failed",
      });
    });
  });

  describe("Skills.list", () => {
    // An unknown session must not error — the `/` menu just has nothing to add.
    it("resolves for an unknown session, rather than failing", async () => {
      const skills = await Effect.runPromise(
        skillsList("nope").pipe(
          Effect.provide(
            Layer.mergeAll(
              base,
              SessionStore.Default,
              Layer.effect(
                AgentResourceService,
                makeAgentResourceService({ managedRoot: join(root, "agent-resources") }),
              ),
            ),
          ),
        ),
      );
      // No session → no worktree to scan, and no harness discovered → nothing to
      // ask. Whatever the operator's real ~/.claude/skills holds may still be
      // scanned, so we assert the CONTRACT rather than a count: it resolves, and
      // it never conjures a command the harness doesn't have. `/plan`, `/test`
      // and `/commit` used to be served from a hardcoded list; none are real.
      expect(Array.isArray(skills)).toBe(true);
      expect(skills).toContainEqual({
        name: "/explain",
        description: "Publish a focused visual explanation of the current technical topic.",
        source: "skill",
      });
      expect(skills).toContainEqual({
        name: "/ponytail",
        description: "Set Ponytail mode: lite, full, ultra, off, status, or default <mode>.",
        source: "command",
      });
      expect(skills.map((s) => s.name)).not.toContain("/plan");
      expect(skills.map((s) => s.name)).not.toContain("/test");
      expect(skills.map((s) => s.name)).not.toContain("/commit");
    });

    it("uses enabled Jingler-managed resources as the composer command surface", async () => {
      const sourceRoot = join(dir, "detected", "prompts");
      const sourcePath = join(sourceRoot, "review.md");
      mkdirSync(sourceRoot, { recursive: true });
      writeFileSync(sourcePath, "Review the current changes");
      const service = await Effect.runPromise(
        makeAgentResourceService({ managedRoot: join(root, "agent-resources") }),
      );
      const candidate = Schema.decodeUnknownSync(DetectedResourceCandidate)({
        id: "review",
        kind: "prompt",
        name: "Review",
        description: "Review current changes",
        byteLength: 26,
        provenance: {
          origin: "jingler",
          sourceRoot,
          sourcePath,
          importedAt: null,
        },
      });
      await Effect.runPromise(service.importResources(
        [candidate],
        { kind: "portable", allowedTargets: [] },
      ));

      const skills = await Effect.runPromise(
        skillsList("nope").pipe(
          Effect.provide(Layer.mergeAll(
            base,
            SessionStore.Default,
            Layer.succeed(AgentResourceService, service),
          )),
        ),
      );

      expect(skills).toContainEqual({
        name: "/review",
        description: "Review current changes",
        source: "command",
      });
      expect(skills.map(({ name }) => name)).toEqual(expect.arrayContaining([
        "/explain",
        "/ponytail",
        "/ponytail-review",
        "/ponytail-audit",
        "/ponytail-debt",
        "/ponytail-gain",
        "/ponytail-help",
      ]));
    });
  });

  describe("Sessions.transcriptPage — attachment stripping", () => {
    /**
     * A transcript's images are 80% of its bytes (98MB of 123MB, measured across
     * the six largest on a real install) and its text is 1.5%. Handing those to
     * the renderer on open is what made a session cost hundreds of megabytes
     * there, so the RPC ships the metadata and the renderer fetches bytes per
     * thumbnail.
     */
    const image = (id: string, data: string) => ({
      _tag: "Image" as const,
      attachment: { id, name: `${id}.png`, mediaType: "image/png", data },
    });
    const message = (id: string, parts: ReadonlyArray<unknown>) =>
      ({
        id,
        role: "user",
        streaming: false,
        createdAt: "2026-07-11T00:00:00.000Z",
        parts,
      }) as never;

    it("empties the base64 but keeps everything a thumbnail needs", () => {
      const [out] = withoutAttachmentData([
        message("u_1", [image("att_1", "AAAABBBB")]),
      ]);
      const part = out!.parts[0] as ReturnType<typeof image>;
      expect(part.attachment.data).toBe("");
      // The tile renders its frame, filename and alt text before the bytes land,
      // and the id is how it asks for them — losing any of these turns a lazy
      // image into a missing one.
      expect(part.attachment.id).toBe("att_1");
      expect(part.attachment.name).toBe("att_1.png");
      expect(part.attachment.mediaType).toBe("image/png");
    });

    it("returns an image-free message BY REFERENCE", () => {
      // Not a micro-optimisation: this walks transcripts that reach 46MB, on
      // every session open, and the renderer's footprint is a high-water mark of
      // exactly these loads. Copying a message to change nothing in it is the
      // cost the whole function exists to avoid, and `toStrictEqual` would pass
      // against a version that copied every one.
      const plain = message("u_2", [
        { _tag: "Text", text: "no pictures here" },
      ]);
      const [out] = withoutAttachmentData([plain]);
      expect(out).toBe(plain);
    });

    it("leaves non-image parts of a message that HAS an image alone", () => {
      const text = { _tag: "Text" as const, text: "what is wrong here" };
      const [out] = withoutAttachmentData([
        message("u_3", [image("att_2", "CCCC"), text]),
      ]);
      expect(out!.parts[1]).toBe(text);
    });
  });

  describe("Sessions.diff", () => {
    // An unknown session (or one without a worktree) has no diff to load.
    it("returns an empty diff for an unknown session", async () => {
      const patch = await Effect.runPromise(
        sessionDiff("nope").pipe(
          Effect.provide(
            Layer.mergeAll(
              base,
              SessionStore.Default,
              WorkspaceService.Default,
            ),
          ),
        ),
      );
      expect(patch).toBe("");
    });

    it("surfaces git failures instead of reporting no changes", async () => {
      mkdirSync(root, { recursive: true });
      writeFileSync(
        join(root, "sessions.json"),
        JSON.stringify([
          {
            id: "broken-worktree",
            repo: "widget",
            branch: "feature",
            title: "Broken worktree",
            status: "idle",
            diff: { added: 0, removed: 0 },
            prNumber: null,
            costUsd: 0,
            tokens: 0,
            updatedAt: "2026-08-08T10:00:00.000Z",
            worktreePath: join(dir, "missing-worktree"),
            chats: [],
            activeChatId: null,
          },
        ]),
      );

      const error = await Effect.runPromise(
        sessionDiff("broken-worktree").pipe(
          Effect.flip,
          Effect.provide(
            Layer.mergeAll(
              base,
              SessionStore.Default,
              WorkspaceService.Default,
            ),
          ),
        ),
      );

      expect(error).toBeInstanceOf(GitError);
    });
  });

  describe("Asset.list", () => {
    it("resolves only the requested session's validated worktree files", async () => {
      const now = "2026-07-30T10:00:00.000Z";
      const worktreePath = join(dir, "asset-worktree");
      mkdirSync(worktreePath, { recursive: true });
      execFileSync("git", ["init"], { cwd: worktreePath, stdio: "ignore" });
      writeFileSync(join(worktreePath, "tracked.md"), "# Tracked\n");
      execFileSync("git", ["add", "tracked.md"], {
        cwd: worktreePath,
        stdio: "ignore",
      });
      writeFileSync(join(worktreePath, "fresh.txt"), "new\n");

      mkdirSync(root, { recursive: true });
      writeFileSync(
        join(root, "sessions.json"),
        JSON.stringify([
          {
            id: "asset-session",
            repo: "widget",
            branch: "jingler/assets",
            title: "Assets",
            status: "idle",
            connectionId: "anthropic-max",
            providerId: "anthropic",
            modelId: "anthropic/claude-sonnet-4-5",
            diff: { added: 0, removed: 0 },
            prNumber: null,
            costUsd: 0,
            tokens: 0,
            updatedAt: now,
            worktreePath,
            chats: [],
            activeChatId: null,
          },
        ]),
      );
      const layer = Layer.mergeAll(
        SessionStore.Default,
        AssetService.Default,
      ).pipe(Layer.provideMerge(base));

      await expect(
        Effect.runPromise(
          assetList({ sessionId: "asset-session" }).pipe(Effect.provide(layer)),
        ),
      ).resolves.toEqual([
        { path: "fresh.txt", status: "untracked" },
        { path: "tracked.md", status: "added" },
      ]);
      await expect(
        Effect.runPromise(
          assetList({ sessionId: "missing" }).pipe(Effect.provide(layer)),
        ),
      ).rejects.toThrow();
    });

    it("routes revision-checked reads and writes through the requested session worktree", async () => {
      const now = "2026-07-30T10:00:00.000Z";
      const worktreePath = join(dir, "editable-asset-worktree");
      mkdirSync(worktreePath, { recursive: true });
      writeFileSync(join(worktreePath, "config.custom"), "before\n");
      mkdirSync(root, { recursive: true });
      writeFileSync(
        join(root, "sessions.json"),
        JSON.stringify([
          {
            id: "editable-asset-session",
            repo: "widget",
            branch: "jingler/editable-assets",
            title: "Editable assets",
            status: "idle",
            diff: { added: 0, removed: 0 },
            prNumber: null,
            costUsd: 0,
            tokens: 0,
            updatedAt: now,
            worktreePath,
            chats: [],
            activeChatId: null,
          },
        ]),
      );
      const layer = Layer.mergeAll(
        SessionStore.Default,
        AssetService.Default,
      ).pipe(Layer.provideMerge(base));

      const loaded = await Effect.runPromise(
        assetRead({
          sessionId: "editable-asset-session",
          path: "config.custom",
        }).pipe(Effect.provide(layer)),
      );
      expect(loaded).toMatchObject({
        kind: "text",
        text: "before\n",
        revision: expect.stringMatching(/^sha256:/),
      });
      if (loaded.kind === "image" || loaded.kind === "pdf") return;

      const saved = await Effect.runPromise(
        assetWrite({
          sessionId: "editable-asset-session",
          path: "config.custom",
          text: "after\n",
          expectedRevision: loaded.revision,
        }).pipe(Effect.provide(layer)),
      );
      expect(saved).toMatchObject({ kind: "text", text: "after\n" });
      expect(saved.revision).not.toBe(loaded.revision);
      expect(readFileSync(join(worktreePath, "config.custom"), "utf8")).toBe(
        "after\n",
      );
    });
  });

  describe("Workspace.revert*", () => {
    // Revert on an unknown / worktree-less session must be a safe no-op.
    it("no-ops for an unknown session (no worktree to touch)", async () => {
      const ws = Layer.mergeAll(
        base,
        SessionStore.Default,
        WorkspaceService.Default,
      );
      await expect(
        Effect.runPromise(
          workspaceRevertFile({ sessionId: "nope", path: "a.ts" }).pipe(
            Effect.provide(ws),
          ),
        ),
      ).resolves.toBeUndefined();
      await expect(
        Effect.runPromise(
          workspaceRevertLines({
            sessionId: "nope",
            path: "a.ts",
            startLine: 1,
            endLine: 2,
          }).pipe(Effect.provide(ws)),
        ),
      ).resolves.toBeUndefined();
    });

    it("refuses destructive revert actions for a direct session", async () => {
      const now = "2026-07-30T10:00:00.000Z";
      mkdirSync(root, { recursive: true });
      writeFileSync(
        join(root, "sessions.json"),
        JSON.stringify([
          {
            id: "direct-session",
            repo: "widget",
            branch: "main",
            baseBranch: "main",
            title: "Production checkout",
            status: "idle",
            diff: { added: 0, removed: 0 },
            prNumber: null,
            costUsd: 0,
            tokens: 0,
            updatedAt: now,
            worktreePath: dir,
            repoPath: dir,
            workspaceMode: "direct",
            chats: [
              {
                id: "direct-chat",
                title: null,
                createdAt: now,
                updatedAt: now,
              },
            ],
            activeChatId: "direct-chat",
          },
        ]),
      );
      const ws = Layer.mergeAll(
        base,
        SessionStore.Default,
        WorkspaceService.Default,
      );

      await expect(
        Effect.runPromise(
          workspaceRevertFile({
            sessionId: "direct-session",
            path: "developer-edit.ts",
          }).pipe(Effect.provide(ws)),
        ),
      ).rejects.toThrow(/disabled for direct sessions/i);
      await expect(
        Effect.runPromise(
          workspaceRevertLines({
            sessionId: "direct-session",
            path: "developer-edit.ts",
            startLine: 1,
            endLine: 2,
          }).pipe(Effect.provide(ws)),
        ),
      ).rejects.toThrow(/disabled for direct sessions/i);
    });
  });

  describe("Terminal.create", () => {
    // The renderer stays oblivious to worktree paths: the handler resolves cwd
    // (explicit cwd wins; otherwise the session's worktree; otherwise the
    // process cwd). Uses a real PTY, always reclaimed via killAll.
    const runCreate = (input: {
      sessionId: string;
      cwd?: string;
      cols: number;
      rows: number;
    }) =>
      Effect.runPromise(
        Effect.gen(function* () {
          const info = yield* createTerminal(input);
          yield* Effect.flatMap(TerminalService, (t) => t.killAll); // reclaim the PTY
          return info;
        }).pipe(
          Effect.provide(
            Layer.mergeAll(base, SessionStore.Default, TerminalService.Default),
          ),
        ),
      );

    it("spawns in an explicit cwd when one is given", async () => {
      const info = await runCreate({
        sessionId: "s1",
        cwd: dir,
        cols: 80,
        rows: 24,
      });
      expect(info.cwd).toBe(dir);
      expect(info.status).toBe("running");
      expect(info.sessionId).toBe("s1");
    });

    it("anchors a session-less terminal to home, NOT the app's own directory", async () => {
      // This test used to assert the opposite — that the terminal fell back to
      // `process.cwd()`. That was the bug written down as a guarantee: the app's
      // cwd is, in development, whichever worktree `pnpm dev` was launched from,
      // so a terminal with no worktree opened *inside an unrelated repo* and
      // anything typed there ran against that repo's files.
      const info = await runCreate({ sessionId: "nope", cols: 80, rows: 24 });
      expect(info.cwd).toBe(homedir());
      expect(info.cwd).not.toBe(process.cwd());
    });
  });

  describe("Github.pr / Github.detectPr", () => {
    // A PR-less / unknown session must be a no-op (null), never an error, so the
    // renderer shows the empty "Create pull request" state.
    it("returns null for an unknown session without a GitHub request", async () => {
      const github = Layer.mergeAll(
        base,
        SessionStore.Default,
        fakeGithubApi(),
        Layer.succeed(GitService, {
          branchAt: () => Effect.succeed(null),
        } as never),
        Layer.succeed(GitHubAuth, {
          upsertSessionRoute: () => Effect.die("unexpected route registration"),
        } as never),
      );
      const pr = await Effect.runPromise(
        githubPr("nope").pipe(Effect.provide(github)),
      );
      expect(pr).toBeNull();
      const detected = await Effect.runPromise(
        githubDetectPr("nope").pipe(Effect.provide(github)),
      );
      expect(detected).toBeNull();
    });

    it("synchronizes the live branch and replacement PR route before returning", async () => {
      const now = "2026-08-11T06:00:00.000Z";
      const worktreePath = join(dir, "replacement-pr-worktree");
      mkdirSync(root, { recursive: true });
      mkdirSync(worktreePath, { recursive: true });
      writeFileSync(
        join(root, "sessions.json"),
        JSON.stringify([
          {
            id: "replacement-session",
            repo: "widget",
            branch: "fix/original-pr",
            baseBranch: "main",
            title: "Replacement PR",
            status: "idle",
            cli: "claude",
            diff: { added: 0, removed: 0 },
            prNumber: 42,
            githubInstallationId: "99",
            githubRepositoryId: "200",
            costUsd: 0,
            tokens: 0,
            updatedAt: now,
            worktreePath,
            workspaceMode: "worktree",
            semanticBranchPending: false,
            semanticBranchProposal: { type: "fix", slug: "original-pr" },
            chats: [{ id: "replacement-chat", title: null, createdAt: now, updatedAt: now }],
            activeChatId: "replacement-chat",
          },
        ]),
      );
      const upsertSessionRoute = vi.fn(() =>
        Effect.succeed({
          sessionId: "replacement-session",
          relaySessionId: "relay-replacement",
          installationId: "99",
          repositoryId: "200",
          pullRequestNumber: 43,
          state: "active" as const,
          updatedAt: now,
        }),
      );
      const github = Layer.mergeAll(
        base,
        SessionStore.Default,
        fakeGithubApi({
          prForWorktree: () => Effect.succeed(43),
          repository: () =>
            Effect.succeed({
              id: "200",
              installationId: "99",
              fullName: "acme/widget",
            }),
        }),
        Layer.succeed(GitService, {
          branchAt: () => Effect.succeed("fix/replacement-pr"),
        } as never),
        Layer.succeed(GitHubAuth, { upsertSessionRoute } as never),
      );

      await expect(
        Effect.runPromise(
          githubDetectPr("replacement-session").pipe(Effect.provide(github)),
        ),
      ).resolves.toBe(43);
      await expect(
        Effect.runPromise(
          SessionStore.get("replacement-session").pipe(Effect.provide(github)),
        ),
      ).resolves.toMatchObject({
        branch: "fix/replacement-pr",
        prNumber: 43,
        githubInstallationId: "99",
        githubRepositoryId: "200",
      });
      expect(upsertSessionRoute).toHaveBeenCalledWith({
        sessionId: "replacement-session",
        installationId: "99",
        repositoryId: "200",
        pullRequestNumber: 43,
      });
    });
  });

  describe("Github.submitReview", () => {
    // Unlike the reads above, submitting is a user-initiated write: silently
    // succeeding on a session with no PR would swallow the reviewer's drafts
    // with no sign they went nowhere.
    it("fails rather than silently dropping drafts when no PR is linked", async () => {
      const github = Layer.mergeAll(
        base,
        SessionStore.Default,
        fakeGithubApi(),
      );
      const exit = await Effect.runPromiseExit(
        githubSubmitReview({
          sessionId: "nope",
          comments: [{ path: "a.ts", line: 2, startLine: null, body: "c" }],
        }).pipe(Effect.provide(github)),
      );
      expect(exit._tag).toBe("Failure");
    });

    /**
     * The whole point of the handler: a draft written on a line becomes an
     * INLINE comment on that line, anchored to the PR's current head. Asserting
     * the typed API payload is the only way to know that — every
     * layer above it can look correct while posting a flattened blob.
     */
    it("posts anchorable drafts inline and folds the rest into the body", async () => {
      mkdirSync(root, { recursive: true });
      writeFileSync(
        join(root, "sessions.json"),
        JSON.stringify([
          {
            id: "s1",
            repo: "widget",
            branch: "feature",
            title: "Feature",
            status: "idle",
            diff: { added: 0, removed: 0 },
            prNumber: 42,
            costUsd: 0,
            tokens: 0,
            updatedAt: "2026-07-16T10:00:00.000Z",
            worktreePath: join(root, "worktrees", "s1"),
            baseBranch: "main",
          },
        ]),
      );

      let posted: {
        commitSha: string;
        body: string;
        comments: ReadonlyArray<Record<string, unknown>>;
      } | null = null;
      const github = Layer.mergeAll(
        base,
        SessionStore.Default,
        fakeGithubApi({
          prHeadSha: () => Effect.succeed("headsha"),
          prDiff: () =>
            Effect.succeed(
              [
                "diff --git a/a.ts b/a.ts",
                "--- a/a.ts",
                "+++ b/a.ts",
                "@@ -1,1 +1,2 @@",
                " const x = 1",
                "+const y = 2",
              ].join("\n"),
            ),
          prReviewComments: (_cwd: string, _number: number, input: unknown) =>
            Effect.sync(() => {
              posted = input as typeof posted;
            }),
        }),
      );

      const unanchored = await Effect.runPromise(
        githubSubmitReview({
          sessionId: "s1",
          comments: [
            { path: "a.ts", line: 2, startLine: null, body: "on the diff" },
            {
              path: "a.ts",
              line: 99,
              startLine: null,
              body: "moved off the diff",
            },
          ],
        }).pipe(Effect.provide(github)),
      );

      expect(unanchored).toBe(1);
      expect(posted).not.toBeNull();
      expect(posted!.commitSha).toBe("headsha");
      expect(posted!.comments).toStrictEqual([
        { path: "a.ts", line: 2, startLine: null, body: "on the diff" },
      ]);
      // The stale one keeps its words instead of 422-ing the whole review.
      expect(posted!.body).toContain("moved off the diff");
      expect(posted!.body).toContain("a.ts:99");
    });
  });

  /**
   * The head-SHA short-circuit is what makes the auto-review trigger safe to
   * fire off a poll loop: an unchanged PR must cost one cheap API read, never
   * an agent run. These tests count reviewer spawns to assert that as a fact
   * rather than an intention.
   */
  describe("Review.run", () => {
    /** Persist a session with a linked PR by writing the store's own file. */
    const withSession = (over: Partial<Session> = {}) => {
      mkdirSync(root, { recursive: true });
      writeFileSync(
        join(root, "sessions.json"),
        JSON.stringify([
          {
            id: "s1",
            repo: "widget",
            branch: "feature",
            title: "Feature",
            status: "idle",
            connectionId: "anthropic-max",
            providerId: "anthropic",
            modelId: "anthropic/claude-sonnet-4-5",
            diff: { added: 0, removed: 0 },
            prNumber: 42,
            costUsd: 0,
            tokens: 0,
            updatedAt: "2026-07-16T10:00:00.000Z",
            worktreePath: join(root, "worktrees", "s1"),
            baseBranch: "main",
            ...over,
          },
        ]),
      );
    };

    /**
     * The typed API reports a fixed head SHA + a non-empty diff, on a host where the
     * `claude` binary resolves. The binary matters: with no binary the reviewer
     * would be dispatched to the scripted stub, and ReviewService rejects that
     * rather than pass stub prose off as a review.
     */
    const fakeGitHub = (headSha: string) =>
      Layer.mergeAll(
        fakeCommandExecutor((cmd, args) => {
          if (cmd === "which" || cmd === "where") {
            return args[0] === "claude"
              ? { stdout: "/usr/local/bin/claude" }
              : { stdout: "" };
          }
          return { stdout: "2.1.0" };
        }),
        fakeGithubApi({
          prHeadSha: () => Effect.succeed(headSha),
          prDiff: () => Effect.succeed("diff --git a/a.ts b/a.ts\n+x\n"),
        }),
      );

    /** A reviewer stub that counts its runs and always reports one finding. */
    const countingAdapter = () => {
      const spawns: AgentTurnSpec[] = [];
      const layer = Layer.succeed(
        AgentTurnDriver,
        AgentTurnDriver.of({
          run: ((_id: string, spec: AgentTurnSpec, ctx: AgentContext) =>
            Effect.gen(function* () {
              spawns.push(spec);
              yield* ctx.emit({
                _tag: "Assistant",
                text: '```json\n{"findings":[{"title":"A bug","severity":"major"}]}\n```',
              });
            })) as AgentTurnDriverShape["run"],
          stop: () => Effect.void,
        }),
      );
      return { spawns, layer };
    };

    const envFor = (headSha: string, adapter: Layer.Layer<AgentTurnDriver>) =>
      Layer.mergeAll(
        Layer.succeed(AppPaths, appPathsFor(root)),
        NodeContext.layer,
        fakeGitHub(headSha),
      ).pipe((leaf) =>
        Layer.mergeAll(
          ConfigService.Default,
          SessionStore.Default,
          ReviewStore.Default,
          ReviewService.Default,
          adapter,
        ).pipe(Layer.provideMerge(leaf)),
      );

    it("fails with ReviewError when the session has no linked PR", async () => {
      withSession({ prNumber: null });
      const { layer } = countingAdapter();
      const exit = await Effect.runPromiseExit(
        reviewRun("s1", false).pipe(Effect.provide(envFor("abc", layer))),
      );
      expect(exit._tag).toBe("Failure");
    });

    it("fails with ReviewError for an unknown session", async () => {
      const { layer, spawns } = countingAdapter();
      const exit = await Effect.runPromiseExit(
        reviewRun("nope", false).pipe(Effect.provide(envFor("abc", layer))),
      );
      expect(exit._tag).toBe("Failure");
      expect(spawns).toHaveLength(0);
    });

    it("runs the reviewer and stores the review against the PR head", async () => {
      withSession();
      const { layer, spawns } = countingAdapter();
      const review = await Effect.runPromise(
        reviewRun("s1", false).pipe(Effect.provide(envFor("sha-one", layer))),
      );
      expect(spawns).toHaveLength(1);
      expect(review.headSha).toBe("sha-one");
      expect(review.findings).toHaveLength(1);
      expect(review.modelId).toBe("anthropic/claude-sonnet-4-5");
    });

    it("does not expose or stamp a stored review after the active PR changes", async () => {
      withSession({ prNumber: 42 });
      const { layer } = countingAdapter();
      const env = envFor("sha-one", layer);
      await Effect.runPromise(reviewRun("s1", false).pipe(Effect.provide(env)));

      withSession({ prNumber: 43 });
      const visible = await Effect.runPromise(
        reviewGet("s1").pipe(Effect.provide(env)),
      );
      const stamp = await Effect.runPromise(
        reviewMarkRouted("s1").pipe(Effect.provide(env)),
      );
      expect(visible).toBeNull();
      expect(stamp).toBeNull();
    });

    /**
     * Reconciliation credits the commits that fixed findings. What matters here
     * is the NULL contract: the renderer calls this after every settled turn, so
     * "nothing changed" must be distinguishable from "here is a review", or the
     * review pane re-renders on every turn for nothing.
     */
    describe("Review.reconcile", () => {
      /** Typed API fixture plus a `git log` whose output is the commits since the head. */
      const gitEnv = (
        headSha: string,
        log: string,
        adapter: Layer.Layer<AgentTurnDriver>,
      ) =>
        Layer.mergeAll(
          Layer.succeed(AppPaths, appPathsFor(root)),
          NodeContext.layer,
          fakeCommandExecutor((cmd, args) => {
            if (cmd === "which" || cmd === "where") {
              return args[0] === "claude"
                ? { stdout: "/usr/local/bin/claude" }
                : { stdout: "" };
            }
            if (cmd === "git")
              return args[2] === "log" ? { stdout: log } : { stdout: "" };
            return { stdout: "2.1.0" };
          }),
          fakeGithubApi({
            prHeadSha: () => Effect.succeed(headSha),
            prDiff: () => Effect.succeed("diff --git a/a.ts b/a.ts\n+x\n"),
          }),
        ).pipe((leaf) =>
          Layer.mergeAll(
            ConfigService.Default,
            SessionStore.Default,
            GitService.Default,
            ReviewStore.Default,
            ReviewService.Default,
            adapter,
          ).pipe(Layer.provideMerge(leaf)),
        );

      /** `git log --reverse --name-only --pretty=format:%H\x1f%s` output. */
      const gitLog = (sha: string, subject: string, files: string[]) =>
        `${sha}\x1f${subject}\n${files.join("\n")}\n`;

      it("returns null when there is no stored review", async () => {
        withSession();
        const { layer } = countingAdapter();
        const out = await Effect.runPromise(
          reviewReconcile("s1").pipe(
            Effect.provide(gitEnv("sha-one", "", layer)),
          ),
        );
        expect(out).toBeNull();
      });

      it("credits the commit that touched the finding's file, and persists it", async () => {
        withSession();
        const { layer } = countingAdapter();
        // The stub reports one finding with no path, so anchor it by hand — the
        // attribution rule is path-based and a pathless finding never resolves.
        const seed = gitEnv("sha-one", "", layer);
        const stored = await Effect.runPromise(
          reviewRun("s1", false).pipe(Effect.provide(seed)),
        );
        await Effect.runPromise(
          ReviewStore.set("s1", {
            ...stored,
            findings: [{ ...stored.findings[0]!, path: "src/auth.ts" }],
          }).pipe(Effect.provide(seed)),
        );

        const env = gitEnv(
          "sha-one",
          gitLog(
            "9f2c1ab4e7d8905361bb2f0c4a7e13d5c8a6b204",
            "fix(auth): timingSafeEqual",
            ["src/auth.ts"],
          ),
          layer,
        );
        const out = await Effect.runPromise(
          reviewReconcile("s1").pipe(Effect.provide(env)),
        );
        expect(out?.findings[0]?.resolvedBy).toMatchObject({
          sha: "9f2c1ab4e7d8905361bb2f0c4a7e13d5c8a6b204",
          subject: "fix(auth): timingSafeEqual",
        });
        // Persisted, not just returned — the next read must agree.
        const reread = await Effect.runPromise(
          reviewGet("s1").pipe(Effect.provide(env)),
        );
        expect(reread?.findings[0]?.resolvedBy?.sha).toBe(
          "9f2c1ab4e7d8905361bb2f0c4a7e13d5c8a6b204",
        );
      });

      it("returns null when no commit touched a finding's file", async () => {
        withSession();
        const { layer } = countingAdapter();
        const seed = gitEnv("sha-one", "", layer);
        const stored = await Effect.runPromise(
          reviewRun("s1", false).pipe(Effect.provide(seed)),
        );
        await Effect.runPromise(
          ReviewStore.set("s1", {
            ...stored,
            findings: [{ ...stored.findings[0]!, path: "src/auth.ts" }],
          }).pipe(Effect.provide(seed)),
        );

        const out = await Effect.runPromise(
          reviewReconcile("s1").pipe(
            Effect.provide(
              gitEnv(
                "sha-one",
                gitLog("aaa", "unrelated", ["src/other.ts"]),
                layer,
              ),
            ),
          ),
        );
        expect(out).toBeNull();
      });

      it("returns null for a session with no worktree", async () => {
        withSession({ worktreePath: undefined });
        const { layer } = countingAdapter();
        const out = await Effect.runPromise(
          reviewReconcile("s1").pipe(
            Effect.provide(gitEnv("sha-one", "", layer)),
          ),
        );
        expect(out).toBeNull();
      });

      it("does not reconcile a stored review from a previous PR", async () => {
        withSession({ prNumber: 42 });
        const { layer } = countingAdapter();
        const env = gitEnv("sha-one", "", layer);
        await Effect.runPromise(
          reviewRun("s1", false).pipe(Effect.provide(env)),
        );

        withSession({ prNumber: 43 });
        const out = await Effect.runPromise(
          reviewReconcile("s1").pipe(Effect.provide(env)),
        );
        expect(out).toBeNull();
      });
    });

    it("re-running on an unchanged head returns the stored review WITHOUT spawning a reviewer", async () => {
      withSession();
      const { layer, spawns } = countingAdapter();
      const env = envFor("sha-one", layer);
      const first = await Effect.runPromise(
        reviewRun("s1", false).pipe(Effect.provide(env)),
      );
      const second = await Effect.runPromise(
        reviewRun("s1", false).pipe(Effect.provide(env)),
      );
      expect(spawns).toHaveLength(1);
      expect(second.createdAt).toBe(first.createdAt);
    });

    it("force re-runs even on an unchanged head", async () => {
      withSession();
      const { layer, spawns } = countingAdapter();
      const env = envFor("sha-one", layer);
      await Effect.runPromise(reviewRun("s1", false).pipe(Effect.provide(env)));
      await Effect.runPromise(reviewRun("s1", true).pipe(Effect.provide(env)));
      expect(spawns).toHaveLength(2);
    });

    it("re-reviews once the PR head advances", async () => {
      withSession();
      const { layer, spawns } = countingAdapter();
      await Effect.runPromise(
        reviewRun("s1", false).pipe(Effect.provide(envFor("sha-one", layer))),
      );
      const second = await Effect.runPromise(
        reviewRun("s1", false).pipe(Effect.provide(envFor("sha-two", layer))),
      );
      expect(spawns).toHaveLength(2);
      expect(second.headSha).toBe("sha-two");
    });

    it("uses the session's certified provider model", async () => {
      withSession();
      const { layer, spawns } = countingAdapter();
      const review = await Effect.runPromise(
        reviewRun("s1", false).pipe(Effect.provide(envFor("sha-one", layer))),
      );
      expect(review.modelId).toBe("anthropic/claude-sonnet-4-5");
      expect(spawns[0]!.modelId).toBe("anthropic/claude-sonnet-4-5");
    });

    /**
     * Posting the low-severity half to the PR.
     *
     * The payload's SHAPE is `planReviewPost`'s business and is pinned there
     * (review-post.test.ts). What these pin is the handler's job: does it
     * call GitHub at all, on which path, and what does it stamp on the review.
     */
    describe("posting to the PR", () => {
      /** A diff whose new side has lines 1–3, so a finding can actually anchor. */
      const POSTABLE_DIFF = [
        "diff --git a/a.ts b/a.ts",
        "--- a/a.ts",
        "+++ b/a.ts",
        "@@ -1 +1,3 @@",
        " one",
        "+two",
        "+three",
      ].join("\n");

      /** Typed API that records writes and can reject the review payload. */
      const recordingGithub = (
        headSha: string,
        opts: { postFails?: boolean } = {},
      ) => {
        const calls: Array<string> = [];
        const layer = Layer.mergeAll(
          fakeCommandExecutor((cmd, args) => {
            if (cmd === "which" || cmd === "where") {
              return args[0] === "claude"
                ? { stdout: "/usr/local/bin/claude" }
                : { stdout: "" };
            }
            return { stdout: "2.1.0" };
          }),
          fakeGithubApi({
            prHeadSha: () => Effect.succeed(headSha),
            prDiff: () => Effect.succeed(POSTABLE_DIFF),
            prReviewComments: () => {
              calls.push("prReviewComments");
              return opts.postFails
                ? Effect.fail(
                    new GitHubApiError({
                      reason: "validation",
                      message: "HTTP 422: line must be part of the diff",
                      status: 422,
                    }),
                  )
                : Effect.void;
            },
          }),
        );
        return { calls, layer };
      };

      /** A reviewer stub reporting exactly `findings`. */
      const adapterReporting = (
        findings: ReadonlyArray<Record<string, unknown>>,
      ) =>
        Layer.succeed(
          AgentTurnDriver,
          AgentTurnDriver.of({
            run: ((_id: string, _spec: AgentTurnSpec, ctx: AgentContext) =>
              ctx.emit({
                _tag: "Assistant",
                text: `\`\`\`json\n${JSON.stringify({ findings })}\n\`\`\``,
              })) as AgentTurnDriverShape["run"],
            stop: () => Effect.void,
          }),
        );

      const envWith = (
        github: Layer.Layer<GitHubApi | CommandExecutor.CommandExecutor>,
        adapter: Layer.Layer<AgentTurnDriver>,
      ) =>
        Layer.mergeAll(
          Layer.succeed(AppPaths, appPathsFor(root)),
          NodeContext.layer,
          github,
        ).pipe((leaf) =>
          Layer.mergeAll(
            ConfigService.Default,
            SessionStore.Default,
            ReviewStore.Default,
            ReviewService.Default,
            adapter,
          ).pipe(Layer.provideMerge(leaf)),
        );

      const isReviewPost = (call: string) => call === "prReviewComments";

      it("posts the minor/nit findings and stamps postedAt", async () => {
        withSession();
        const { calls, layer: github } = recordingGithub("sha-one");
        const review = await Effect.runPromise(
          reviewRun("s1", false).pipe(
            Effect.provide(
              envWith(
                github,
                adapterReporting([
                  {
                    title: "Prefer const",
                    severity: "nit",
                    path: "a.ts",
                    line: 2,
                  },
                ]),
              ),
            ),
          ),
        );
        expect(calls.filter(isReviewPost)).toHaveLength(1);
        expect(review.postedAt).not.toBeNull();
        expect(review.postError).toBeNull();
      });

      // The critical/major half belongs to the agent. Posting it here would both
      // duplicate it and turn the reviewer into a PR spammer.
      it("posts nothing when every finding is critical or major", async () => {
        withSession();
        const { calls, layer: github } = recordingGithub("sha-one");
        const review = await Effect.runPromise(
          reviewRun("s1", false).pipe(
            Effect.provide(
              envWith(
                github,
                adapterReporting([
                  {
                    title: "Data loss",
                    severity: "critical",
                    path: "a.ts",
                    line: 2,
                  },
                ]),
              ),
            ),
          ),
        );
        expect(calls.filter(isReviewPost)).toHaveLength(0);
        expect(review.postedAt).toBeNull();
        expect(review.postError).toBeNull();
      });

      /**
       * The best-effort guarantee. Failing the run instead would throw away a
       * review that cost real tokens AND (because the caller only persists on
       * success) leave the auto-trigger re-spawning the reviewer every tick.
       */
      it("keeps the review and records postError when GitHub rejects the post", async () => {
        withSession();
        const { layer: github } = recordingGithub("sha-one", {
          postFails: true,
        });
        const review = await Effect.runPromise(
          reviewRun("s1", false).pipe(
            Effect.provide(
              envWith(
                github,
                adapterReporting([
                  {
                    title: "Prefer const",
                    severity: "nit",
                    path: "a.ts",
                    line: 2,
                  },
                ]),
              ),
            ),
          ),
        );
        expect(review.findings).toHaveLength(1);
        expect(review.postedAt).toBeNull();
        expect(review.postError).toContain("HTTP 422");
      });

      it("persists the failed post so the UI still sees it after a reload", async () => {
        withSession();
        const { layer: github } = recordingGithub("sha-one", {
          postFails: true,
        });
        const env = envWith(
          github,
          adapterReporting([
            { title: "Prefer const", severity: "nit", path: "a.ts", line: 2 },
          ]),
        );
        await Effect.runPromise(
          reviewRun("s1", false).pipe(Effect.provide(env)),
        );
        const stored = await Effect.runPromise(
          reviewGet("s1").pipe(Effect.provide(env)),
        );
        expect(stored?.postError).toContain("HTTP 422");
      });

      /**
       * The de-dupe path must not re-post. Without this the auto-review poll
       * would add the same nits to the PR every 60 seconds, forever.
       */
      it("does not re-post when the head is unchanged", async () => {
        withSession();
        const { calls, layer: github } = recordingGithub("sha-one");
        const env = envWith(
          github,
          adapterReporting([
            { title: "Prefer const", severity: "nit", path: "a.ts", line: 2 },
          ]),
        );
        await Effect.runPromise(
          reviewRun("s1", false).pipe(Effect.provide(env)),
        );
        await Effect.runPromise(
          reviewRun("s1", false).pipe(Effect.provide(env)),
        );
        await Effect.runPromise(
          reviewRun("s1", false).pipe(Effect.provide(env)),
        );
        expect(calls.filter(isReviewPost)).toHaveLength(1);
      });
    });

    /**
     * The stamp that makes auto-routing idempotent across reloads. The renderer
     * does the routing (it owns the conversation actor); main only remembers.
     */
    describe("Review.markRouted", () => {
      const env = () =>
        Layer.mergeAll(
          Layer.succeed(AppPaths, appPathsFor(root)),
          NodeContext.layer,
          fakeGitHub("sha-one"),
        ).pipe((leaf) =>
          Layer.mergeAll(
            ConfigService.Default,
            SessionStore.Default,
            ReviewStore.Default,
            ReviewService.Default,
            countingAdapter().layer,
          ).pipe(Layer.provideMerge(leaf)),
        );

      it("stamps an unrouted review and persists it", async () => {
        withSession();
        const layer = env();
        await Effect.runPromise(
          reviewRun("s1", false).pipe(Effect.provide(layer)),
        );
        const stamp = await Effect.runPromise(
          reviewMarkRouted("s1").pipe(Effect.provide(layer)),
        );
        expect(stamp).not.toBeNull();
        const stored = await Effect.runPromise(
          reviewGet("s1").pipe(Effect.provide(layer)),
        );
        expect(stored?.routedAt).toBe(stamp);
      });

      /**
       * The renderer calls this from an effect, and an effect can fire twice
       * (StrictMode, two panes on one session). The stamp is a fact about the
       * FIRST routing — a second call must not move it.
       */
      it("keeps the original stamp when called again", async () => {
        withSession();
        const layer = env();
        await Effect.runPromise(
          reviewRun("s1", false).pipe(Effect.provide(layer)),
        );
        const first = await Effect.runPromise(
          reviewMarkRouted("s1").pipe(Effect.provide(layer)),
        );
        const second = await Effect.runPromise(
          reviewMarkRouted("s1").pipe(Effect.provide(layer)),
        );
        expect(second).toBe(first);
      });

      // Null, not a stamp: claiming "routed" for a review that doesn't exist
      // would leave findings reading as sent that no agent ever heard about.
      it("returns null when there is no stored review", async () => {
        withSession();
        const stamp = await Effect.runPromise(
          reviewMarkRouted("s1").pipe(Effect.provide(env())),
        );
        expect(stamp).toBeNull();
      });

      /**
       * The end-to-end refutation of "a failed persist makes markRouted return
       * null forever, so routing re-sends indefinitely".
       *
       * It can't. `ReviewStore.set` updates its in-memory mirror UNCONDITIONALLY
       * (that write is the de-dupe's brake and provably cannot fail), and only
       * the DISK write is best-effort. So a `reviewRun` whose reviews dir is
       * unwritable still leaves the mirror holding the review — and
       * `reviewMarkRouted`, which reads through the same process's mirror, stamps
       * it just fine. The disk failure costs durability across a restart, not the
       * stamp; and across a restart the renderer re-reads null too, so it never
       * routes a review main has forgotten.
       */
      it("stamps a routedAt even when the reviews dir is unwritable", async () => {
        withSession();
        // A file where the reviews DIRECTORY should be → every write beneath it
        // fails, exactly like a permissions/full-disk failure.
        mkdirSync(root, { recursive: true });
        writeFileSync(join(root, "reviews"), "not a directory");
        // BOTH calls under ONE layer build, which is the whole point: production
        // runs every RPC on a single `ManagedRuntime.make(AppLayer)`, so the
        // ReviewStore — and its in-memory mirror — is a process singleton shared
        // across reviewRun and reviewMarkRouted. Providing the layer per
        // `runPromise` would build a fresh, empty mirror each time and prove
        // nothing about the real code.
        const stamp = await Effect.runPromise(
          Effect.gen(function* () {
            yield* reviewRun("s1", false);
            return yield* reviewMarkRouted("s1");
          }).pipe(Effect.provide(env())),
        );
        expect(stamp).not.toBeNull();
      });
    });
  });
});

describe("memoryExport", () => {
  let exportDir: string;
  let exportBase: Layer.Layer<
    ConfigService | AppPaths | NodeContext.NodeContext
  >;
  beforeEach(() => {
    exportDir = mkdtempSync(join(tmpdir(), "jingler-export-"));
    exportBase = Layer.mergeAll(
      ConfigService.Default,
      Layer.succeed(AppPaths, appPathsFor(join(exportDir, "jingler"))),
      NodeContext.layer,
    );
  });
  afterEach(() => rmSync(exportDir, { recursive: true, force: true }));

  const vault = {
    format: "jingler-obsidian-vault" as const,
    version: 1 as const,
    files: [
      {
        path: "runbook.md",
        content: "# Runbook\n\nSee [[Incident Response]].\n",
      },
    ],
  };

  // `MemoryService` is an Effect.Service, so its Context value carries `_tag`.
  const fakeMemory = (payload: unknown, onUiRequest: () => void) =>
    Layer.succeed(
      MemoryService,
      MemoryService.make({
        attachment: () => Effect.succeed(null),
        retainSettledTurn: () => Effect.succeed(false),
        recoverCaptures: () => Effect.succeed(null),
        diagnostics: () => Effect.succeed({
          attachmentStatus: "disabled",
          queuedRetentions: 0,
          retryingRetentions: 0
        }),
        diagnosticsSnapshot: () => ({
          attachmentStatus: "disabled",
          queuedRetentions: 0,
          retryingRetentions: 0
        }),
        access: () => Effect.succeed(null),
        uiRequest: () => {
          onUiRequest();
          return Effect.succeed(payload);
        },
        suggestions: () => Effect.succeed(null),
      }),
    );

  const saveDialog = (saveDestination: string | null) =>
    Layer.succeed(DialogService, {
      chooseDirectory: () => Effect.succeed(null),
      saveFile: () => Effect.succeed(saveDestination),
    });

  it("never touches the memory backend when the save dialog is cancelled", async () => {
    let backendCalls = 0;
    const result = await Effect.runPromise(
      memoryExport("org-1").pipe(
        Effect.provide(
          fakeMemory(vault, () => {
            backendCalls += 1;
          }),
        ),
        Effect.provide(saveDialog(null)),
        Effect.provide(InMemorySecretStoreLive),
        Effect.provide(exportBase),
      ),
    );
    expect(result).toEqual({
      filename: "jingler-memory-org-1.zip",
      saved: false,
    });
    expect(backendCalls).toBe(0);
  });

  it("writes a ZIP of the exported vault to the chosen path", async () => {
    const destination = join(exportDir, "export.zip");
    let backendCalls = 0;
    const result = await Effect.runPromise(
      memoryExport("org-1").pipe(
        Effect.provide(
          fakeMemory(vault, () => {
            backendCalls += 1;
          }),
        ),
        Effect.provide(saveDialog(destination)),
        Effect.provide(InMemorySecretStoreLive),
        Effect.provide(exportBase),
      ),
    );
    expect(result).toEqual({
      filename: "jingler-memory-org-1.zip",
      saved: true,
    });
    expect(backendCalls).toBe(1);
    const archive = readFileSync(destination);
    expect(archive.readUInt32LE(0)).toBe(0x04034b50);
    expect(archive.toString("utf8")).toContain("runbook.md");
    expect(archive.toString("utf8")).toContain("[[Incident Response]]");
  });
});
