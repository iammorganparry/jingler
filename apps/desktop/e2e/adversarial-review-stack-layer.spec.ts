import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { expect, test } from "./fixtures.js"
import { openSessionPr, showPullRequestDetails } from "./pull-request.js"

test("adversarial review on a lower stack layer reviews that PR, not the top one", async ({ launchApp }) => {
  test.setTimeout(120_000)
  const pr = (number: number, headRefName: string, baseRefName: string) => ({
    number, title: `Layer ${number}`, headRefName, baseRefName, author: { login: "octocat" }, state: "OPEN"
  })
  const { window, home } = await launchApp({
    configured: true,
    withRepo: true,
    sessions: (context) => [{
      id: "s_stack", repo: "widget", branch: "stack/ui", title: "Stack session", status: "idle",
      diff: { added: 0, removed: 0 }, prNumber: 482, costUsd: 0, tokens: 0, updatedAt: "2026-10-12T10:00:00.000Z",
      prs: [
        { number: 481, branch: "stack/api", base: "main" },
        { number: 482, branch: "stack/ui", base: "stack/api" }
      ],
      githubInstallationId: "101", githubRepositoryId: "301", worktreePath: context.repoPath
    }],
    githubApp: {
      connected: true,
      userLogin: "e2e-user",
      prs: [pr(481, "stack/api", "main"), pr(482, "stack/ui", "stack/api")],
      diff: "diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -0,0 +1 @@\n+x\n"
    }
  })
  await window.getByTestId("session-row-s_stack").click()
  await openSessionPr(window, 481)
  await window.getByTestId("header-view-checks").click()
  await showPullRequestDetails(window)
  await window.getByRole("button", { name: /Adversarial review/ }).click()

  const reviews = join(home, "jingler", "reviews")
  const lower = join(reviews, "s_stack.pr-481.json")
  await expect.poll(() => existsSync(lower), { timeout: 60_000 }).toBe(true)
  expect(JSON.parse(readFileSync(lower, "utf8")).prNumber).toBe(481)
  expect(existsSync(join(reviews, "s_stack.pr-482.json"))).toBe(false)
})
