import { Either, Schema } from "effect";
import { describe, expect, it } from "vitest";
import {
  AdversarialReview,
  CreateSessionInput,
  defaultModeFor,
  Environment,
  executionTargetOf,
  GitHubRelayDelivery,
  GitHubSessionRelayGrantResponse,
  GitHubSessionRoute,
  GithubConfig,
  IssueDetail,
  IssueReference,
  issueReferenceForProvider,
  issueReferenceOf,
  issueReferencesOf,
  persistentOf,
  Repo,
  Session,
  workspaceModeOf,
  WorkspaceConfig,
} from "./domain.js";
import {
  ProviderConnectionId,
  ProviderId,
  ProviderModelId,
} from "./runtime/provider-connection.js";

/**
 * These schemas back persistence (config.json, sessions.json) and the RPC wire
 * format, so the behaviour that matters is: valid data decodes, `null` is
 * accepted where the domain allows absence, encode→decode is identity, and
 * invalid literals are rejected (not silently coerced). We assert those
 * outcomes — never the schema's internal structure.
 */

// Schema.decodeUnknownEither is the parser at this test boundary; invalid inputs are intentional.
// oxlint-disable-next-line anti-slop/no-unknown-parameters
const decode = <A, I>(schema: Schema.Schema<A, I>, input: unknown) =>
  Schema.decodeUnknownEither(schema)(input);

describe("GitHub session relay schemas", () => {
  const route = {
    sessionId: "s_one",
    relaySessionId: "opaque_session_route_1234",
    installationId: "4492350",
    repositoryId: "301",
    pullRequestNumber: 153,
    state: "active" as const,
    updatedAt: "2026-08-05T15:00:00.000Z",
  };

  it("decodes one opaque relay route for an exact local session", () => {
    expect(Schema.decodeUnknownSync(GitHubSessionRoute)(route)).toStrictEqual(
      route,
    );
  });

  it("requires session-scoped claims for a relay grant", () => {
    const result = decode(GitHubSessionRelayGrantResponse, {
      relayUrl: "https://github-relay.jingler.dev",
      grant: "signed-grant",
      claims: {
        version: 1,
        issuer: "jingler",
        audience: "jingler-github-relay",
        subject: "user-one",
        installationId: route.installationId,
        relaySessionId: route.relaySessionId,
        issuedAt: 1,
        expiresAt: 301,
        grantId: "grant-one",
      },
    });
    expect(Either.isRight(result)).toBe(true);
  });

  it("requires every renderer delivery to identify its exact session", () => {
    const delivery = {
      clientId: "client-one",
      cursor: 1,
      relaySessionId: route.relaySessionId,
      sessionId: route.sessionId,
      chatId: "chat-one",
      event: {
        version: 1,
        deliveryId: "delivery-one",
        semanticKey: "review-comment:1",
        event: "pull_request_review_comment",
        action: "created",
        installationId: route.installationId,
        repository: {
          id: route.repositoryId,
          owner: "owner",
          name: "repo",
          fullName: "owner/repo",
        },
        pullRequest: {
          id: "pr-one",
          number: route.pullRequestNumber,
          title: "Review me",
          url: "https://github.com/owner/repo/pull/153",
          headSha: "head",
          baseSha: "base",
        },
        actor: { id: "actor-one", login: "reviewer", type: "User" },
        feedback: {
          kind: "review-comment",
          id: "comment-one",
          body: "Please fix this",
          state: null,
          path: "src/index.ts",
          line: 3,
          side: "RIGHT",
        },
        actionable: true,
        occurredAt: "2026-08-05T15:00:01.000Z",
      },
    };
    expect(Either.isRight(decode(GitHubRelayDelivery, delivery))).toBe(true);
    expect(
      Either.isLeft(
        decode(GitHubRelayDelivery, { ...delivery, sessionId: undefined }),
      ),
    ).toBe(true);
  });
});

describe("Environment", () => {
  it("decodes legacy environments as owned devices", () => {
    const decoded = Schema.decodeUnknownSync(Environment)({
      id: "device-1",
      name: "buildbox",
      platform: { os: "darwin", arch: "arm64" },
      capabilities: {
        version: 1,
        capabilities: [],
        maxConcurrentSessions: 1,
      },
      state: "online",
      agentVersion: null,
      lastSeenAt: null,
    });

    expect(decoded.kind).toBe("owned");
  });

  it("decodes renderer-safe managed environment metadata", () => {
    const decoded = Schema.decodeUnknownSync(Environment)(
      {
        kind: "managed",
        id: "managed-1",
        name: "Cloud workspace",
        platform: { os: "linux", arch: "x64" },
        capabilities: {
          version: 1,
          capabilities: ["session.start"],
          maxConcurrentSessions: 1,
        },
        state: "sleeping",
        agentVersion: null,
        lastSeenAt: null,
        region: "wnam",
        instanceType: "basic",
        generation: 1,
        createdAt: 1,
        updatedAt: 1,
      },
      { onExcessProperty: "error" },
    );

    expect(decoded).toMatchObject({
      kind: "managed",
      state: "sleeping",
      instanceType: "basic",
    });
  });

  it("rejects credentials embedded in persisted environment metadata", () => {
    expect(() =>
      Schema.decodeUnknownSync(Environment)(
        {
          id: "device-1",
          name: "buildbox",
          platform: { os: "darwin", arch: "arm64" },
          capabilities: {
            version: 1,
            capabilities: [],
            maxConcurrentSessions: 1,
          },
          state: "online",
          agentVersion: null,
          lastSeenAt: null,
          relayGrant: "must-not-cross-renderer",
        },
        { onExcessProperty: "error" },
      ),
    ).toThrow();
  });
});

describe("WorkspaceConfig", () => {
  it("decodes a configured workspace", () => {
    const result = decode(WorkspaceConfig, {
      reposDir: "/Users/me/repos",
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    expect(Either.isRight(result)).toBe(true);
  });

  it("accepts a null reposDir (first-run, before setup)", () => {
    const result = decode(WorkspaceConfig, {
      reposDir: null,
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    expect(Either.isRight(result)).toBe(true);
  });

  it("rejects a config missing createdAt", () => {
    const result = decode(WorkspaceConfig, { reposDir: "/repos" });
    expect(Either.isLeft(result)).toBe(true);
  });

  it("round-trips through encode → decode unchanged", () => {
    const config: WorkspaceConfig = {
      reposDir: "/repos",
      createdAt: "2026-07-11T10:00:00.000Z",
    };
    const roundTripped = Schema.decodeUnknownSync(WorkspaceConfig)(
      Schema.encodeSync(WorkspaceConfig)(config),
    );
    expect(roundTripped).toStrictEqual(config);
  });
});

describe("GithubConfig", () => {
  it("decodes provider-neutral review preferences", () => {
    const result = decode(GithubConfig, {
      enabled: true,
      autoCreatePr: false,
      autoDetectPr: true,
      autoAdversarialReview: true,
      adversarialReviewModel: {
        runtimeId: "claude",
        endpointId: "desktop:claude:default",
        providerId: "anthropic",
        modelId: "anthropic/claude-opus-4-6",
      },
    });
    expect(Either.isRight(result)).toBe(true);
  });

  it("still decodes inside a WorkspaceConfig with a legacy github block", () => {
    const result = decode(WorkspaceConfig, {
      reposDir: "/repos",
      createdAt: "2026-01-01T00:00:00.000Z",
      github: { enabled: true, autoCreatePr: false, autoDetectPr: true },
    });
    expect(Either.isRight(result)).toBe(true);
  });
});

describe("AdversarialReview", () => {
  const review: AdversarialReview = {
    sessionId: "s1",
    prNumber: 42,
    headSha: "abc123",
    connectionId:
      Schema.decodeUnknownSync(ProviderConnectionId)("anthropic-max"),
    providerId: Schema.decodeUnknownSync(ProviderId)("anthropic"),
    modelId: Schema.decodeUnknownSync(ProviderModelId)(
      "anthropic/claude-fable-5",
    ),
    createdAt: "2026-07-16T10:00:00.000Z",
    findings: [
      {
        id: "f1",
        path: "src/auth.ts",
        line: 12,
        endLine: null,
        severity: "critical",
        title: "Token compared with ==",
        rationale:
          "Timing-unsafe comparison lets an attacker probe the token byte by byte.",
        suggestion: "Use timingSafeEqual.",
        resolvedBy: null,
      },
    ],
    note: null,
    routedAt: null,
    postedAt: null,
    postError: null,
  };

  it("round-trips through encode → decode unchanged", () => {
    const roundTripped = Schema.decodeUnknownSync(AdversarialReview)(
      Schema.encodeSync(AdversarialReview)(review),
    );
    expect(roundTripped).toStrictEqual(review);
  });

  /**
   * The back-compat guard. `ReviewStore.readFile` folds a decode failure to null,
   * and a null read makes the auto-trigger run a fresh review — so if a review
   * written before these fields failed to decode, every existing session would
   * silently re-run the priciest model once. The defaults are what stop that.
   */
  it("decodes a review persisted before the routing fields existed", () => {
    const { routedAt, postedAt, postError, ...legacy } = review;
    const result = decode(AdversarialReview, legacy);
    expect(result).toStrictEqual(
      Either.right({
        ...legacy,
        routedAt: null,
        postedAt: null,
        postError: null,
      }),
    );
  });

  it("carries the routing stamps when they are set", () => {
    const result = decode(AdversarialReview, {
      ...review,
      routedAt: "2026-07-16T10:05:00.000Z",
      postedAt: "2026-07-16T10:05:01.000Z",
      postError: null,
    });
    expect(Either.isRight(result)).toBe(true);
  });

  // A reviewer that refuses or emits prose still produces a review — findings
  // empty, note set. That is a success, not an error.
  it("decodes a review with no findings and a note", () => {
    const result = decode(AdversarialReview, {
      ...review,
      findings: [],
      note: "I could not review this diff.",
    });
    expect(Either.isRight(result)).toBe(true);
  });

  it("accepts a finding not anchored to a file", () => {
    const result = decode(AdversarialReview, {
      ...review,
      findings: [
        { ...review.findings[0], path: null, line: null, suggestion: null },
      ],
    });
    expect(Either.isRight(result)).toBe(true);
  });

  it("rejects a severity outside the known set", () => {
    const result = decode(AdversarialReview, {
      ...review,
      findings: [{ ...review.findings[0], severity: "blocker" }],
    });
    expect(Either.isLeft(result)).toBe(true);
  });
});

describe("Session", () => {
  const base: Session = {
    id: "s_fix-login_abc",
    repo: "trigify-app",
    branch: "chore/fix-login",
    title: "Fix login",
    status: "idle",
    diff: { added: 0, removed: 0 },
    prNumber: null,
    costUsd: 0,
    tokens: 0,
    updatedAt: "2026-07-11T10:00:00.000Z",
    chats: [
      {
        id: "c_s_fix-login_abc_1",
        title: null,
        createdAt: "2026-07-11T10:00:00.000Z",
        updatedAt: "2026-07-11T10:00:00.000Z",
      },
    ],
    activeChatId: "c_s_fix-login_abc_1",
  };

  it("decodes a legacy session as non-persistent and worktree-backed", () => {
    const decoded = Schema.decodeUnknownSync(Session)(base);
    expect(persistentOf(decoded)).toBe(false);
    expect(workspaceModeOf(decoded)).toBe("worktree");
  });

  it("decodes a legacy session without environmentId as local", () => {
    const decoded = Schema.decodeUnknownSync(Session)(base);
    expect(executionTargetOf(decoded)).toEqual({ kind: "local" });
  });

  it("round-trips a remote session environment identity", () => {
    const remote = {
      ...base,
      environmentId: "device_buildbox",
      executionLocation: "cloud" as const,
    };
    const decoded = Schema.decodeUnknownSync(Session)(
      Schema.encodeSync(Session)(remote),
    );
    expect(decoded.environmentId).toBe("device_buildbox");
    expect(executionTargetOf(decoded)).toEqual({
      kind: "remote",
      environmentId: "device_buildbox",
    });
  });

  it("round-trips the optional workspace and persistence fields when present", () => {
    const withWorktree: Session = {
      ...base,
      worktreePath: "/Users/me/jingler/worktrees/trigify-app/fix-login",
      workspaceMode: "direct",
      persistent: true,
      baseBranch: "main",
      chats: [{ ...base.chats[0]!, mode: "auto" }],
    };
    const roundTripped = Schema.decodeUnknownSync(Session)(
      Schema.encodeSync(Session)(withWorktree),
    );
    expect(roundTripped).toStrictEqual(withWorktree);
  });

  it("round-trips a provider-neutral linked issue", () => {
    const linkedIssue = Schema.decodeUnknownSync(IssueReference)({
      providerId: "linear",
      id: "issue-opaque-123",
      identifier: "ENG-123",
      url: "https://linear.app/acme/issue/ENG-123",
      title: "Retry failed jobs",
      labels: [{ name: "Bug", color: "ef4444" }],
    });
    const decoded = Schema.decodeUnknownSync(Session)({ ...base, linkedIssue });
    expect(decoded.linkedIssue).toStrictEqual(linkedIssue);
  });

  it("adapts historical GitHub issue fields without eagerly rewriting the session", () => {
    const legacy = Schema.decodeUnknownSync(Session)({
      ...base,
      issueNumber: 128,
      issueUrl: "https://github.com/acme/widgets/issues/128",
      issueTitle: "Retry failed jobs",
      issueLabels: [{ name: "bug", color: "ef4444" }],
    });

    expect(legacy.linkedIssue).toBeUndefined();
    expect(issueReferenceOf(legacy)).toStrictEqual({
      providerId: "github",
      id: "128",
      identifier: "#128",
      url: "https://github.com/acme/widgets/issues/128",
      title: "Retry failed jobs",
      labels: [{ name: "bug", color: "ef4444" }],
    });
    expect(legacy.linkedIssue).toBeUndefined();
  });

  it("prefers the durable provider-neutral link over historical aliases", () => {
    const linkedIssue: IssueReference = {
      providerId: "linear",
      id: "opaque",
      identifier: "ENG-123",
      url: "https://linear.app/acme/issue/ENG-123",
      title: "Retry failed jobs",
      labels: [],
    };
    expect(
      issueReferenceOf({
        linkedIssue,
        issueNumber: 128,
        issueUrl: "https://github.com/acme/widgets/issues/128",
        issueTitle: "Old",
        issueLabels: [],
      }),
    ).toBe(linkedIssue);
  });

  it("round-trips ordered issue links and resolves the provider-scoped selection", () => {
    const github: IssueReference = {
      providerId: "github",
      id: "123",
      identifier: "#123",
      url: "https://github.com/acme/widgets/issues/123",
      title: "GitHub issue",
      labels: [],
    };
    const linear: IssueReference = {
      providerId: "linear",
      id: "123",
      identifier: "ENG-123",
      url: "https://linear.app/acme/issue/ENG-123",
      title: "Linear issue",
      labels: [],
    };
    const decoded = Schema.decodeUnknownSync(Session)({
      ...base,
      linkedIssues: [github, linear],
      selectedIssue: { providerId: "linear", id: "123" },
    });

    expect(issueReferencesOf(decoded)).toStrictEqual([github, linear]);
    expect(issueReferenceOf(decoded)).toStrictEqual(linear);
    expect(issueReferenceForProvider(decoded, "github")).toStrictEqual(github);
  });

  it("treats an explicit empty canonical collection as unlinked", () => {
    const legacy: IssueReference = {
      providerId: "linear",
      id: "legacy",
      identifier: "ENG-1",
      url: "https://linear.app/acme/issue/ENG-1",
      title: "Legacy",
      labels: [],
    };
    const session = {
      linkedIssues: [],
      linkedIssue: legacy,
      issueNumber: 123,
    };
    expect(issueReferencesOf(session)).toStrictEqual([]);
    expect(issueReferenceOf(session)).toBeUndefined();
  });

  it("falls back to the newest link when a stored selection is stale", () => {
    const first: IssueReference = {
      providerId: "linear",
      id: "one",
      identifier: "ENG-1",
      url: "https://linear.app/acme/issue/ENG-1",
      title: "One",
      labels: [],
    };
    const newest: IssueReference = { ...first, id: "two", identifier: "ENG-2" };
    expect(
      issueReferenceOf({
        linkedIssues: [first, newest],
        selectedIssue: { providerId: "linear", id: "missing" },
      }),
    ).toBe(newest);
  });

  it("rejects an unknown status", () => {
    expect(
      Either.isLeft(decode(Session, { ...base, status: "exploding" })),
    ).toBe(true);
  });

  it("does not expose decoder-era cli fields on canonical sessions", () => {
    const decoded = decode(Session, { ...base, cli: "copilot" });
    expect(Either.isRight(decoded)).toBe(true);
    if (Either.isRight(decoded))
      expect(decoded.right).not.toHaveProperty("cli");
  });
});

describe("provider-neutral issue schemas", () => {
  it("decodes normalized Linear issue detail without GitHub-only fields", () => {
    const issue = Schema.decodeUnknownSync(IssueDetail)({
      providerId: "linear",
      id: "opaque-issue-id",
      identifier: "ENG-123",
      url: "https://linear.app/acme/issue/ENG-123",
      title: "Retry failed jobs",
      labels: [{ name: "Bug", color: "ef4444" }],
      state: "open",
      body: "Retries currently stop after one attempt.",
      author: { id: "user-1", name: "Morgan", avatarUrl: null },
      assignees: [],
      updatedAt: "2026-08-08T10:00:00.000Z",
      createdAt: "2026-08-07T10:00:00.000Z",
      comments: [
        {
          id: "comment-1",
          author: null,
          body: "Imported comment",
          createdAt: "2026-08-08T09:00:00.000Z",
        },
      ],
    });
    expect(issue.identifier).toBe("ENG-123");
    expect("number" in issue).toBe(false);
  });
});

describe("Repo", () => {
  it("accepts null for every optional-origin field (repo with no remote)", () => {
    const result = decode(Repo, {
      name: "athena",
      path: "/Users/me/repos/athena",
      defaultBranch: null,
      currentBranch: null,
      remoteUrl: null,
      githubSlug: null,
    });
    expect(Either.isRight(result)).toBe(true);
  });
});

describe("CreateSessionInput", () => {
  it("decodes a canonical provider connection without a legacy cli", () => {
    const result = decode(CreateSessionInput, {
      repoPath: "/Users/me/repos/trigify-app",
      repoName: "trigify-app",
      connectionId: "claude-max",
      providerId: "anthropic",
      modelId: "anthropic/claude-sonnet",
      baseBranch: "main",
    });
    expect(Either.isRight(result)).toBe(true);
  });

  it("rejects a partial provider connection identity", () => {
    const result = decode(CreateSessionInput, {
      repoPath: "/Users/me/repos/trigify-app",
      repoName: "trigify-app",
      connectionId: "claude-max",
      modelId: "anthropic/claude-sonnet",
      baseBranch: "main",
    });
    expect(Either.isLeft(result)).toBe(true);
  });

  it("rejects a legacy harness create request", () => {
    const result = decode(CreateSessionInput, {
      repoPath: "/Users/me/repos/trigify-app",
      repoName: "trigify-app",
      title: "Refactor auth",
      cli: "codex",
      model: "gpt-5.6-sol",
      baseBranch: "main",
    });
    expect(Either.isLeft(result)).toBe(true);
  });

  it("decodes an explicit direct-checkout request", () => {
    const result = decode(CreateSessionInput, {
      repoPath: "/Users/me/repos/trigify-app",
      repoName: "trigify-app",
      connectionId: "codex-subscription",
      providerId: "openai-codex",
      modelId: "openai-codex/gpt-5.6-sol",
      baseBranch: "feature/direct",
      useWorktree: false,
    });
    expect(Either.isRight(result)).toBe(true);
    if (Either.isRight(result)) expect(result.right.useWorktree).toBe(false);
  });

  it("rejects an invalid cli kind", () => {
    const result = decode(CreateSessionInput, {
      repoPath: "/x",
      repoName: "x",
      title: "t",
      cli: "nope",
      baseBranch: "main",
    });
    expect(Either.isLeft(result)).toBe(true);
  });
});

describe("defaultModeFor", () => {
  it("defaults every pi provider model to auto", () => {
    expect(defaultModeFor()).toBe("auto");
  });

  it("honours the operator's configured default over the auto fallback", () => {
    expect(defaultModeFor("accept-edits")).toBe("accept-edits");
    expect(defaultModeFor("ask")).toBe("ask");
  });
});
