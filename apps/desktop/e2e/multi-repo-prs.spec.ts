import { appShell, expect, openSessionByTitle, sessionRow, test } from "./fixtures.js"

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

test("Changes lists a PR's files when the agent has since switched to a repo without one", async ({ launchApp }) => {
  const { window } = await launchApp({
    configured: true,
    withRepo: true,
    sessions: ({ repoPath }) => [{
      id: "s_switched", repo: "widget", branch: "main", title: "switched repo",
      status: "idle" as const, diff: { added: 0, removed: 0 }, prNumber: null,
      githubInstallationId: "101", githubRepositoryId: "301",
      checkouts: [
        { id: "api", repo: "api", branch: "chore/refactor", prNumber: 482, prs: [{ number: 482 }], worktreePath: repoPath, repoPath },
        { id: "web", repo: "widget", branch: "main", prNumber: null, worktreePath: repoPath, repoPath }
      ],
      activeCheckoutId: "web", costUsd: 0, tokens: 0,
      updatedAt: "2026-07-24T10:00:00.000Z", worktreePath: repoPath, repoPath
    }],
    githubApp: {
      connected: true,
      userLogin: "e2e-user",
      prs: [{
        number: 482, title: "Refactor auth flow", headRefName: "chore/refactor", baseRefName: "main",
        author: { login: "e2e-user" }, additions: 1, deletions: 0, files: ["src/api-only.ts"]
      }]
    }
  })
  await expect(appShell(window)).toBeVisible()
  await openSessionByTitle(window, "switched repo")
  await window.getByRole("button", { name: /^Changes\b/ }).first().click()
  const apiGroup = window.getByTestId("changes-checkout-api")
  await expect(apiGroup).toBeVisible({ timeout: 20_000 })
  if ((await apiGroup.getAttribute("open")) === null) await apiGroup.locator("summary").click()
  await expect(apiGroup.locator('[data-item-path="src/api-only.ts"]')).toBeVisible({ timeout: 20_000 })
})
