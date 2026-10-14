/** PR view header and sub-tabs (#440): opened from the header PR chip. */
import { expect, test } from "./fixtures.js"

test("PR chip opens the PR view with header fields and arrow-key sub-tabs", async ({ launchApp }) => {
  const { window } = await launchApp({
    configured: true,
    withRepo: true,
    sessions: (context) => [{
      id: "s_pr_view", repo: "widget", branch: "chore/refactor", title: "PR view test", status: "idle",
      diff: { added: 0, removed: 0 }, prNumber: 482, costUsd: 0, tokens: 0, updatedAt: "2026-10-12T10:00:00.000Z",
      githubInstallationId: "101", githubRepositoryId: "301", worktreePath: context.repoPath
    }],
    githubApp: {
      connected: true,
      userLogin: "e2e-user",
      prs: [{
        number: 482, title: "Refactor auth flow", headRefName: "chore/refactor", baseRefName: "main",
        author: { login: "e2e-user" }, additions: 5, deletions: 2,
        checks: [{ name: "lint", conclusion: "success" }, { name: "unit", conclusion: "success" }, { name: "e2e", conclusion: "failure" }]
      }]
    }
  })
  await window.getByTestId("session-row-s_pr_view").click()
  await window.getByTestId("header-link-pr").click()

  await expect(window.getByRole("heading", { name: /Refactor auth flow/ })).toContainText("#482")
  const meta = window.getByTestId("pr-meta-line")
  await expect(meta).toContainText("Open")
  await expect(meta).toContainText("e2e-user")
  await expect(meta).toContainText("chore/refactor → main")
  await expect(meta).toContainText("1 commit")
  await expect(meta).toContainText("1 file")

  const tabs = window.getByRole("tab")
  await expect(tabs.filter({ hasText: /^Commits 1$/ })).toBeVisible()
  await expect(tabs.filter({ hasText: /^Files 1$/ })).toBeVisible()
  await expect(tabs.filter({ hasText: /^Checks 2\/3$/ })).toBeVisible()

  const conversation = tabs.filter({ hasText: /^Conversation$/ })
  await conversation.focus()
  await window.keyboard.press("ArrowRight")
  await expect(tabs.filter({ hasText: /^Commits 1$/ })).toHaveAttribute("aria-selected", "true")
  await window.keyboard.press("ArrowLeft")
  await expect(conversation).toHaveAttribute("aria-selected", "true")
})
