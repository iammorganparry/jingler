import type { GitHubRelayEvent } from "@jingler/core";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { appShell, expect, openSessionByTitle, test } from "./fixtures.js";

const feedback = (
  deliveryId: string,
  semanticKey: string,
  prNumber: number,
  body: string,
): GitHubRelayEvent => ({
  version: 1,
  deliveryId,
  semanticKey,
  event: "pull_request_review_comment",
  action: "created",
  installationId: "101",
  repository: {
    id: "301",
    owner: "acme",
    name: "widget",
    fullName: "acme/widget",
  },
  pullRequest: {
    id: `pr-${prNumber}`,
    number: prNumber,
    title: `PR ${prNumber}`,
    url: `https://github.test/acme/widget/pull/${prNumber}`,
    headSha: `head-${prNumber}`,
    baseSha: "base",
  },
  actor: { id: "reviewer-1", login: "reviewer", type: "User" },
  feedback: {
    kind: "review-comment",
    id: semanticKey,
    body,
    state: null,
    path: "src/auth.ts",
    line: 17,
    side: "RIGHT",
  },
  actionable: true,
  occurredAt: "2026-08-05T09:00:00.000Z",
});

// This is intentionally one lifecycle test: it crosses two Electron launches,
// a forced post-acceptance failure, reconnect replay, and a busy-agent release.
// Keep its budget local so slower machines do not weaken the suite-wide limit.
test.setTimeout(120_000);

test("uses a distinct relay Durable Object connection per linked session and replays offline feedback in isolation", async ({
  launchApp,
}) => {
  const launched = await launchApp({
    configured: true,
    withRepo: true,
    githubApp: {
      connected: true,
      userLogin: "octocat",
      repositorySelection: "selected",
    },
    e2eEnv: { JINGLER_E2E_GITHUB_FAIL_MARK_ONCE: "1" },
    sessions: ({ repoPath }) => [
      {
        id: "s_pr_42",
        repo: "widget",
        branch: "feat/auth-flow",
        title: "Auth flow",
        status: "idle",
        cli: "claude",
        diff: { added: 0, removed: 0 },
        prNumber: 42,
        githubInstallationId: "101",
        githubRepositoryId: "301",
        costUsd: 0,
        tokens: 0,
        updatedAt: "2026-08-05T08:00:00.000Z",
        worktreePath: repoPath,
        mode: "accept-edits",
      },
      {
        id: "s_pr_43",
        repo: "widget",
        branch: "fix/refresh-token",
        title: "Refresh token",
        status: "idle",
        cli: "claude",
        diff: { added: 0, removed: 0 },
        prNumber: 43,
        githubInstallationId: "101",
        githubRepositoryId: "301",
        costUsd: 0,
        tokens: 0,
        updatedAt: "2026-08-05T08:01:00.000Z",
        worktreePath: repoPath,
        mode: "accept-edits",
      },
    ],
  });

  const { window, githubRelay } = launched;
  await expect(appShell(window)).toBeVisible();
  await expect
    .poll(() => githubRelay.requests.some((request) => request.authorized))
    .toBe(true);
  await expect.poll(() => githubRelay.connectedClientIds().length).toBe(2);
  expect(new Set(githubRelay.connectedClientIds()).size).toBe(2);

  // Removing the selected repository immediately tears down both session
  // streams; restoring the immutable repository id reconciles them in place.
  launched.githubServer.setInstallation({ repositories: [] });
  await expect
    .poll(() => githubRelay.connectedClientIds().length, { timeout: 20_000 })
    .toBe(0);
  launched.githubServer.setInstallation({
    repositories: [{ id: "301", fullName: "acme/widget" }],
  });
  await expect
    .poll(() => githubRelay.connectedClientIds().length, { timeout: 20_000 })
    .toBe(2);

  // Main-process supervision follows live installation state without an app
  // restart. Suspension removes the socket; reactivation creates it again.
  launched.githubServer.setInstallation({
    status: "suspended",
    suspendedAt: "2026-08-05T09:01:00.000Z",
  });
  await expect
    .poll(() => githubRelay.connectedClientIds().length, { timeout: 20_000 })
    .toBe(0);
  launched.githubServer.setInstallation({
    status: "active",
    suspendedAt: null,
  });
  await expect
    .poll(() => githubRelay.connectedClientIds().length, { timeout: 20_000 })
    .toBe(2);

  // A failed reconnect is visible while bounded retries continue, then clears
  // once the next authenticated socket succeeds.
  githubRelay.failNextConnections();
  githubRelay.disconnectAll();
  await expect(
    window
      .getByRole("status")
      .filter({ hasText: "GitHub feedback is reconnecting" }),
  ).toBeVisible({
    timeout: 10_000,
  });
  await expect
    .poll(() => githubRelay.connectedClientIds().length, { timeout: 20_000 })
    .toBe(2);
  await expect(
    window.getByText("GitHub feedback is reconnecting", { exact: false }),
  ).toHaveCount(0);

  const first = "Tighten validation before refreshing credentials.";
  githubRelay.publish(
    "relay-s_pr_42",
    feedback("delivery-1", "comment-1", 42, first),
  );
  await openSessionByTitle(window, "Auth flow");
  await expect(window.getByText(first, { exact: false })).toHaveCount(1, {
    timeout: 20_000,
  });
  const transcript = join(
    launched.home,
    "jingler",
    "transcripts",
    "c_s_pr_42_1.json",
  );
  const acceptedTurnCount = () => {
    if (!existsSync(transcript)) return 0;
    const messages = JSON.parse(readFileSync(transcript, "utf8")) as Array<{
      externalInstruction?: { semanticKey?: string };
    }>;
    return messages.filter(
      (message) => message.externalInstruction?.semanticKey === "comment-1",
    ).length;
  };
  await expect.poll(acceptedTurnCount).toBe(1);
  expect(githubRelay.acknowledgements.some((ack) => ack.cursor === 1)).toBe(
    false,
  );

  // Force the exact crash boundary: main durably accepted and scheduled the
  // visible turn, but the injected mark-dispatched failure left its outbox row
  // pending and cursor unacknowledged. Fresh-app replay must hit transcript
  // idempotency, not create another instruction or agent run.
  await launched.app.close();
  const restarted = await launchApp({
    configured: true,
    withRepo: true,
    home: launched.home,
    reposDir: launched.reposDir,
    userDataDir: launched.userDataDir,
    authServer: launched.authServer,
    githubRelay,
    githubApp: {
      connected: true,
      userLogin: "octocat",
      repositorySelection: "selected",
    },
  });
  await expect(appShell(restarted.window)).toBeVisible();
  await openSessionByTitle(restarted.window, "Auth flow");
  await expect(restarted.window.getByText(first, { exact: false })).toHaveCount(
    1,
  );
  await expect
    .poll(() => githubRelay.acknowledgements.some((ack) => ack.cursor === 1))
    .toBe(true);
  await expect.poll(acceptedTurnCount).toBe(1);
  const currentWindow = restarted.window;

  // The fake relay enforces both GitHub delivery and semantic deduplication.
  expect(
    githubRelay.publish(
      "relay-s_pr_42",
      feedback("delivery-1", "comment-1", 42, first),
    ),
  ).toBeNull();
  await expect(currentWindow.getByText(first, { exact: false })).toHaveCount(1);

  // Disconnect before persistence so cursor 2 is replayed after reconnect.
  githubRelay.disconnectAll();
  const second = "Keep this change isolated to the refresh-token session.";
  githubRelay.publish(
    "relay-s_pr_43",
    feedback("delivery-2", "comment-2", 43, second),
  );
  await openSessionByTitle(currentWindow, "Refresh token");
  await expect(currentWindow.getByText(second, { exact: false })).toHaveCount(
    1,
    {
      timeout: 20_000,
    },
  );
  await expect
    .poll(() => githubRelay.acknowledgements.some((ack) => ack.cursor === 2))
    .toBe(true);

  await openSessionByTitle(currentWindow, "Auth flow");
  await expect(currentWindow.getByText(second, { exact: false })).toHaveCount(
    0,
  );

  // Feedback arriving while the agent is paused stays in the existing actor's
  // visible queue; no second/hidden run is spawned.
  await openSessionByTitle(currentWindow, "Refresh token");
  await expect(
    currentWindow.getByRole("button", { name: /Allow once/ }),
  ).toBeVisible({
    timeout: 20_000,
  });
  const busy = "Also cover the token rotation edge case.";
  githubRelay.publish(
    "relay-s_pr_43",
    feedback("delivery-3", "comment-3", 43, busy),
  );
  await expect(currentWindow.getByText(busy, { exact: false })).toHaveCount(1, {
    timeout: 20_000,
  });
  expect(githubRelay.acknowledgements.some((ack) => ack.cursor === 3)).toBe(
    false,
  );
  await currentWindow.getByRole("button", { name: /Allow once/ }).click();
  await expect
    .poll(() => githubRelay.acknowledgements.some((ack) => ack.cursor === 3))
    .toBe(true);

  const busyTranscript = join(
    restarted.home,
    "jingler",
    "transcripts",
    "c_s_pr_43_1.json",
  );
  const busyTurnCounts = () => {
    if (!existsSync(busyTranscript)) return { identified: 0, visible: 0 };
    const messages = JSON.parse(readFileSync(busyTranscript, "utf8")) as Array<{
      role?: string;
      externalInstruction?: { semanticKey?: string };
      parts?: Array<{ _tag?: string; text?: string }>;
    }>;
    return {
      identified: messages.filter(
        (message) => message.externalInstruction?.semanticKey === "comment-3",
      ).length,
      visible: messages.filter(
        (message) =>
          message.role === "user" &&
          message.parts?.some(
            (part) => part._tag === "Text" && part.text?.includes(busy),
          ),
      ).length,
    };
  };
  // Native steer stores only a plain user message and cannot carry the relay
  // identity. Seeing one identified turn after the busy run settles proves the
  // queued item entered Agent.run, while the text count proves it happened once.
  await expect.poll(busyTurnCounts).toEqual({ identified: 1, visible: 1 });
});
