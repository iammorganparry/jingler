import { describe, expect, it, vi } from "vitest";
import type {
  GitHubDeliveryLedger,
  GitHubFeedbackTarget,
  GitHubRelayEvent,
} from "../../../../packages/cli-adapters/src/github-events.js";
import { claimGitHubDelivery } from "../../../../packages/cli-adapters/src/github-events.js";
import { GitHubFeedbackRouter } from "./github-feedback.js";

const target = (
  patch: Partial<GitHubFeedbackTarget> = {},
): GitHubFeedbackTarget => ({
  sessionId: "session-1",
  chatId: "chat-1",
  installationId: "99",
  repositoryId: "200",
  prNumber: 42,
  archived: false,
  ...patch,
});

const event = (patch: Partial<GitHubRelayEvent> = {}): GitHubRelayEvent => ({
  version: 1,
  deliveryId: "delivery-1",
  semanticKey: "semantic-1",
  event: "pull_request_review_comment",
  action: "created",
  installationId: "99",
  repository: {
    id: "200",
    owner: "acme",
    name: "widget",
    fullName: "acme/widget",
  },
  pullRequest: {
    id: "300",
    number: 42,
    title: "Improve routing",
    url: "https://github.test/acme/widget/pull/42",
    headSha: "head",
    baseSha: "base",
  },
  actor: { id: "400", login: "reviewer", type: "User" },
  feedback: {
    kind: "review-comment",
    id: "500",
    body: "Please handle the reconnect race.",
    state: null,
    path: "src/relay.ts",
    line: 27,
    side: "RIGHT",
  },
  actionable: true,
  occurredAt: "2026-08-05T09:00:00.000Z",
  ...patch,
});

const setup = (input?: {
  readonly target?: GitHubFeedbackTarget;
  readonly state?: Map<string, "pending" | "dispatched">;
  readonly failDispatch?: boolean;
}) => {
  let ledger: GitHubDeliveryLedger = { deliveryIds: [], semanticKeys: [] };
  const state = input?.state ?? new Map<string, "pending" | "dispatched">();
  const order: string[] = [];
  const dispatch = vi.fn(async () => {
    order.push("dispatch");
    if (input?.failDispatch) throw new Error("renderer crashed");
  });
  const invalidate = vi.fn();
  const exactTarget = input?.target ?? target();
  const router = new GitHubFeedbackRouter({
    claim: async (claimedTarget, nextEvent) => {
      if (
        claimedTarget.archived ||
        claimedTarget.sessionId !== exactTarget.sessionId ||
        claimedTarget.installationId !== nextEvent.installationId ||
        claimedTarget.repositoryId !== nextEvent.repository.id ||
        claimedTarget.prNumber !== nextEvent.pullRequest?.number
      )
        return "rejected";
      const existing = state.get(nextEvent.semanticKey);
      if (existing) return existing;
      order.push("persist");
      state.set(nextEvent.semanticKey, "pending");
      return "pending";
    },
    markDispatched: async (_target, nextEvent) => {
      const claimed = claimGitHubDelivery(ledger, nextEvent);
      ledger = claimed.ledger;
      state.set(nextEvent.semanticKey, "dispatched");
      order.push("mark");
      return true;
    },
    dispatch,
    invalidate,
  });
  return {
    router,
    dispatch,
    invalidate,
    order,
    ledger: () => ledger,
    state,
    target: exactTarget,
  };
};

describe("GitHubFeedbackRouter", () => {
  it("persists then sends one location-aware instruction through the visible conversation", async () => {
    const h = setup();
    await expect(h.router.route(event(), h.target)).resolves.toEqual({
      status: "routed",
      sessionId: "session-1",
    });
    expect(h.order).toEqual(["persist", "dispatch", "mark"]);
    expect(h.dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "session-1",
        chatId: "chat-1",
        externalInstruction: {
          source: "github-feedback",
          deliveryId: "delivery-1",
          semanticKey: "semantic-1",
        },
        text: expect.stringContaining("Location: src/relay.ts:27 (RIGHT)"),
      }),
    );
  });

  it("invalidates queries but never starts turns for state/check notifications", async () => {
    const h = setup();
    await expect(
      h.router.route(
        event({
          event: "check_run",
          action: "completed",
          pullRequest: null,
          feedback: null,
          actionable: false,
        }),
        h.target,
      ),
    ).resolves.toEqual({ status: "ignored", reason: "not-actionable" });
    await expect(
      h.router.route(
        event({
          deliveryId: "delivery-status",
          semanticKey: "status-head-success",
          event: "status",
          action: "success",
          pullRequest: null,
          feedback: null,
          actionable: false,
        }),
        h.target,
      ),
    ).resolves.toEqual({ status: "ignored", reason: "not-actionable" });
    expect(h.invalidate).toHaveBeenCalledTimes(2);
    expect(h.dispatch).not.toHaveBeenCalled();
  });

  it("suppresses duplicate delivery ids and semantically unchanged edits", async () => {
    const h = setup();
    await h.router.route(event(), h.target);
    await expect(h.router.route(event(), h.target)).resolves.toEqual({
      status: "ignored",
      reason: "duplicate",
    });
    await expect(
      h.router.route(event({ deliveryId: "delivery-2" }), h.target),
    ).resolves.toEqual({ status: "ignored", reason: "duplicate" });
    expect(h.dispatch).toHaveBeenCalledOnce();
  });

  it("does not cross installation, repository, PR, or archived-session boundaries", async () => {
    const h = setup();
    await expect(
      h.router.route(event({ installationId: "100" }), h.target),
    ).resolves.toEqual({
      status: "ignored",
      reason: "unlinked",
    });
    await expect(
      h.router.route(
        event({ repository: { ...event().repository, id: "201" } }),
        h.target,
      ),
    ).resolves.toEqual({ status: "ignored", reason: "unlinked" });
    await expect(
      h.router.route(
        event({ pullRequest: { ...event().pullRequest!, number: 43 } }),
        h.target,
      ),
    ).resolves.toEqual({ status: "ignored", reason: "unlinked" });
    const archived = setup({ target: target({ archived: true }) });
    await expect(
      archived.router.route(event(), archived.target),
    ).resolves.toEqual({
      status: "ignored",
      reason: "unlinked",
    });
    expect(h.dispatch).not.toHaveBeenCalled();
    expect(archived.dispatch).not.toHaveBeenCalled();
  });

  it("routes actionable human feedback even when it uses the connected user's login", async () => {
    const h = setup();
    await expect(
      h.router.route(
        event({ actor: { ...event().actor, login: "octocat", type: "User" } }),
        h.target,
      ),
    ).resolves.toEqual({ status: "routed", sessionId: "session-1" });
    expect(h.dispatch).toHaveBeenCalledOnce();
  });

  it("serializes simultaneous frames so both durable claims are retained", async () => {
    const h = setup();
    await Promise.all([
      h.router.route(event(), h.target),
      h.router.route(
        event({ deliveryId: "delivery-2", semanticKey: "semantic-2" }),
        h.target,
      ),
    ]);
    expect(h.ledger().deliveryIds).toEqual(["delivery-1", "delivery-2"]);
    expect(h.dispatch).toHaveBeenCalledTimes(2);
  });

  it("does not let a busy session block feedback for another session", async () => {
    let releaseFirst!: () => void;
    const firstAccepted = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const dispatched: string[] = [];
    const router = new GitHubFeedbackRouter({
      claim: async () => "pending",
      markDispatched: async () => true,
      invalidate: () => {},
      dispatch: async ({ sessionId }) => {
        dispatched.push(sessionId);
        if (sessionId === "session-1") await firstAccepted;
      },
    });

    const blocked = router.route(event(), target());
    await vi.waitFor(() => expect(dispatched).toEqual(["session-1"]));
    await expect(
      router.route(
        event({ deliveryId: "delivery-2", semanticKey: "semantic-2" }),
        target({ sessionId: "session-2", chatId: "chat-2" }),
      ),
    ).resolves.toEqual({ status: "routed", sessionId: "session-2" });
    expect(dispatched).toEqual(["session-1", "session-2"]);

    releaseFirst();
    await expect(blocked).resolves.toEqual({
      status: "routed",
      sessionId: "session-1",
    });
  });

  it("retries a pending outbox entry after a crash between persistence and dispatch", async () => {
    const state = new Map<string, "pending" | "dispatched">();
    const crashed = setup({ state, failDispatch: true });
    await expect(crashed.router.route(event(), crashed.target)).rejects.toThrow(
      "renderer crashed",
    );
    expect(state.get("semantic-1")).toBe("pending");

    const restarted = setup({ state });
    await expect(
      restarted.router.route(event(), restarted.target),
    ).resolves.toEqual({
      status: "routed",
      sessionId: "session-1",
    });
    expect(restarted.order).toEqual(["dispatch", "mark"]);
    expect(state.get("semantic-1")).toBe("dispatched");
  });
});
