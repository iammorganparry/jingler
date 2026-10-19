/**
 * "Ask agent to resolve conflicts" in the PR side panel (#436): clicking it
 * posts the conflict-resolution prompt (naming the conflicting files) into the
 * session's own chat, as a normal turn — replacing the old dead end.
 */
import { expect, test } from "./fixtures.js"
import { showPullRequestDetails } from "./pull-request.js"

test("Ask agent to resolve conflicts sends the conflict prompt into the session's chat", async ({ launchApp }) => {
  const { window } = await launchApp({
    configured: true,
    withRepo: true,
    sessions: (context) => [{
      id: "s_conflict", repo: "widget", branch: "chore/refactor", title: "Conflict resolve test", status: "idle",
      diff: { added: 0, removed: 0 }, prNumber: 482, costUsd: 0, tokens: 0, updatedAt: "2026-10-12T10:00:00.000Z",
      githubInstallationId: "101", githubRepositoryId: "301", worktreePath: context.repoPath
    }],
    githubApp: {
      connected: true,
      userLogin: "e2e-user",
      prs: [{
        number: 482, title: "Refactor auth flow", headRefName: "chore/refactor", baseRefName: "main",
        author: { login: "e2e-user" }, mergeStateStatus: "DIRTY"
      }]
    }
  })

  await window.getByTestId("session-row-s_conflict").click()
  await window.getByTestId("header-link-pr").click()
  await showPullRequestDetails(window)

  const resolveButton = window.getByRole("button", { name: "Ask agent to resolve conflicts" })
  await expect(resolveButton).toBeEnabled({ timeout: 10_000 })
  await resolveButton.click()

  // Routed to the session's own agent as a normal conversation turn, naming
  // the file the fake GitHub server's /files endpoint reports as changed.
  await window.getByTestId("header-view-checks").click()
  await expect(window.getByTestId("conversation-scroll").getByText(/Resolve the merge conflicts/)).toBeVisible({ timeout: 10_000 })
  await expect(window.getByTestId("conversation-scroll").getByText("src/auth.ts")).toBeVisible()
})
