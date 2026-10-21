import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { expect, sessionRow, test } from "./fixtures.js"
import { showPullRequestDetails } from "./pull-request.js"

const review = {
  sessionId: "s_pr", prNumber: 482, headSha: "9f3c1ab7d2e4f5061728394a5b6c7d8e9f0a1b2c",
  connectionId: null, providerId: null, modelId: null, legacyModel: "claude-fable-5",
  createdAt: "2026-07-16T10:00:00.000Z", note: null, routedAt: null, postedAt: null, postError: null,
  findings: [{
    id: "f1", path: "src/auth.ts", line: 4, endLine: null, severity: "major",
    title: "Refresh retries forever", rationale: "No backoff on 401.", suggestion: null, resolvedBy: null
  }]
}

test("dismissed review findings survive a reload and can be shown again", async ({ launchApp }) => {
  const { window } = await launchApp({
    configured: true, withRepo: true,
    seed: ({ home }) => {
      const dir = join(home, "jingler", "reviews")
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, "s_pr.json"), JSON.stringify(review))
    },
    sessions: ({ repoPath }) => [{
      id: "s_pr", repo: "widget", branch: "chore/refactor", title: "Refactor auth flow", status: "idle",
      diff: { added: 1, removed: 0 }, prNumber: 482, githubInstallationId: "101", githubRepositoryId: "301",
      costUsd: 0, tokens: 0, updatedAt: "2026-07-11T00:00:00.000Z", worktreePath: repoPath
    }],
    githubApp: {
      connected: true, userLogin: "e2e-user",
      prs: [{ number: 482, title: "Refactor auth flow", headRefName: "chore/refactor", baseRefName: "main",
        author: { login: "e2e-user" }, additions: 1, deletions: 0 }]
    }
  })
  await window.evaluate(() => localStorage.setItem("jingler:mcp-import-prompt:v1", "done"))
  const open = async () => {
    await sessionRow(window, "Refactor auth flow").click()
    await window.getByTestId("header-view-checks").click()
    await showPullRequestDetails(window)
  }
  await window.reload()
  await open()
  const title = window.getByText("Refresh retries forever", { exact: true })
  await expect(title).toBeVisible()
  await window.getByRole("button", { name: "Dismiss", exact: true }).click()
  await expect(title).toHaveCount(0)

  await window.reload()
  await open()
  const show = window.getByRole("button", { name: "Dismissed (1) · Show", exact: true })
  await expect(show).toBeVisible()
  await expect(title).toHaveCount(0)
  await show.click()
  await expect(title).toBeVisible()
})
