import { expect, sessionRow, test } from "./fixtures.js"

test("a multi-repo session shows every checkout's PR labelled with its repo", async ({ launchApp }) => {
  const { window } = await launchApp({
    configured: true,
    withRepo: true,
    sessions: ({ repoPath }) => [
      {
        id: "s_multi", repo: "qa-web", branch: "fix/x", title: "multi repo pr",
        status: "idle" as const, diff: { added: 1, removed: 0 }, prNumber: 1,
        prs: [{ number: 2, repo: "qa-api" }, { number: 1, repo: "qa-web" }],
        checkouts: [
          { id: "web", repo: "qa-web", branch: "fix/x", prNumber: 1, worktreePath: repoPath },
          { id: "api", repo: "qa-api", branch: "fix/x", prNumber: 2, worktreePath: repoPath }
        ],
        activeCheckoutId: "web", costUsd: 0, tokens: 0,
        updatedAt: "2026-07-24T10:00:00.000Z", worktreePath: repoPath
      }
    ]
  })
  const row = sessionRow(window, "multi repo pr")
  await expect(row.getByText("qa-api #2")).toBeVisible()
  await expect(row.getByText("qa-web #1")).toBeVisible()
})
