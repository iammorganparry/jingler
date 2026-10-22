/** PR view header and sub-tabs (#440): opened from the header PR chip. */
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { delimiter, join } from "node:path"
import { appShell, expect, test } from "./fixtures.js"
import type { SeedSession } from "./fixtures.js"

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

  await expect(window.getByText("No description provided.")).toBeVisible()
  await expect(window.getByRole("button", { name: "Approve", exact: true })).toBeDisabled()
  await expect(window.getByRole("button", { name: "Request changes", exact: true })).toBeDisabled()

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

test("PR right rail shows its sections and collapses to a sheet when narrow", async ({ launchApp }) => {
  const { window } = await launchApp({
    configured: true,
    withRepo: true,
    sessions: (context) => [{
      id: "s_pr_rail", repo: "widget", branch: "chore/refactor", title: "PR rail test", status: "idle",
      diff: { added: 0, removed: 0 }, prNumber: 482, costUsd: 0, tokens: 0, updatedAt: "2026-10-12T10:00:00.000Z",
      githubInstallationId: "101", githubRepositoryId: "301", worktreePath: context.repoPath
    }],
    githubApp: {
      connected: true,
      userLogin: "e2e-user",
      prs: [{
        number: 482, title: "Refactor auth flow", headRefName: "chore/refactor", baseRefName: "main",
        author: { login: "e2e-user" }, additions: 5, deletions: 2,
        checks: [{ name: "lint", conclusion: "success" }, { name: "e2e", conclusion: "failure" }]
      }]
    }
  })
  await window.setViewportSize({ width: 1800, height: 900 })
  await window.getByTestId("session-row-s_pr_rail").click()
  await window.getByTestId("header-link-pr").click()

  await expect(window.getByText("1/2 passing")).toBeVisible()
  await expect(window.getByText("Reviewers", { exact: true })).toHaveCount(0)
  await expect(window.getByRole("button", { name: "Pull request details" })).toHaveCount(0)

  await window.setViewportSize({ width: 800, height: 900 })
  await expect(window.getByText("1/2 passing")).toHaveCount(0)
  await window.getByRole("button", { name: "Pull request details" }).click()
  await expect(window.getByText("1/2 passing")).toBeVisible()
})

const DRAFTS = [
  { id: "d1", severity: "issue", path: "src/auth.ts", line: 42, body: "Token read before null check." },
  { id: "d2", severity: "nit", path: "src/auth.ts", line: 57, body: "Prefer a named constant." }
]

/** A fake `gh` serving one inbox PR (#42) through the authenticated CLI. */
const installGh = () => {
  const root = mkdtempSync(join(tmpdir(), "jingler-e2e-review-drawer-"))
  const bin = join(root, "bin")
  mkdirSync(bin)
  const inbox = [{ data: { viewer: { login: "octocat" }, search: { nodes: [{
    assignees: { nodes: [] }, author: { login: "octocat", avatarUrl: null }, comments: { totalCount: 0 }, isDraft: false,
    labels: { nodes: [] }, number: 42, repository: { nameWithOwner: "acme/widget" }, reviewRequests: { nodes: [] },
    state: "OPEN", title: "Drawer PR", updatedAt: "2026-10-01T08:00:00.000Z", url: "https://github.com/acme/widget/pull/42"
  }], pageInfo: { hasNextPage: false, endCursor: null } } } }]
  const pr = {
    state: "OPEN", number: 42, title: "Drawer PR", body: "Drawer PR body.", url: "https://github.com/acme/widget/pull/42",
    author: { login: "octocat" }, headRefName: "feature", baseRefName: "main", headRefOid: "abc", isDraft: false, commits: [],
    additions: 3, deletions: 1, labels: [], reviews: [], comments: [], reviewRequests: [], statusCheckRollup: []
  }
  const empty = (key: string) => `[{ data: { repository: { pullRequest: { ${key}: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } } } } }]`
  writeFileSync(join(bin, "gh"), [
    "#!/usr/bin/env node",
    "const args = process.argv.slice(2)", "const joined = args.join(' ')",
    `const inbox = ${JSON.stringify(inbox)}`, `const pr = ${JSON.stringify(pr)}`,
    "if (args[0] === 'auth' && args[1] === 'status') process.exit(0)",
    "if (args[0] === 'pr' && args[1] === 'view') { console.log(JSON.stringify(joined.includes('number,state') ? { number: 42, state: 'OPEN' } : pr)); process.exit(0) }",
    "if (args[0] === 'repo' && args[1] === 'view') { console.log('acme/widget'); process.exit(0) }",
    "if (args[0] === 'api' && args[1] === 'repos/acme/widget') { console.log(JSON.stringify({ id: 7, node_id: 'R_7' })); process.exit(0) }",
    "if (args[0] === 'api' && args[1] === 'repos/acme/widget/pulls/42/files') { console.log('[[]]'); process.exit(0) }",
    "if (args[0] === 'api' && args[1] === 'graphql') {",
    "  if (joined.includes('search(query:')) console.log(JSON.stringify(inbox))",
    `  else if (joined.includes('commits(first:100')) console.log(${JSON.stringify(empty("commits"))})`,
    `  else console.log(${JSON.stringify(empty("reviewThreads"))})`,
    "  process.exit(0)", "}", "process.exit(1)"
  ].join("\n"))
  chmodSync(join(bin, "gh"), 0o755)
  return { root, env: { PATH: `${bin}${delimiter}${process.env.PATH ?? ""}` } }
}

const sessionFor = (prNumber: number | null) => ({ repoPath }: { repoPath: string }): ReadonlyArray<SeedSession> => [{
  id: "s_drawer", repo: "widget", branch: "feature", title: "Drawer session", status: "idle", diff: { added: 3, removed: 1 },
  prNumber, costUsd: 0, tokens: 0, updatedAt: "2026-10-01T08:00:00.000Z", worktreePath: repoPath, mode: "accept-edits"
}]

const openInboxPr = async (window: import("@playwright/test").Page) => {
  await window.evaluate((drafts) => localStorage.setItem("jingler:e2e-review-drafts", JSON.stringify(drafts)), DRAFTS)
  await window.reload()
  await expect(appShell(window)).toBeVisible()
  await window.getByTestId("pull-requests-sidebar-item").click()
  const inbox = window.getByTestId("pull-request-inbox")
  await inbox.getByRole("button", { name: /Drawer PR/ }).click()
  await expect(inbox.getByRole("heading", { name: "Drawer PR" })).toBeVisible()
  return inbox
}

test("Review drawer on the inbox PR collapses the rail, hands drafts to the composer, and posts nothing", async ({ launchApp }) => {
  test.setTimeout(120_000)
  const gh = installGh()
  try {
    const { window, githubServer } = await launchApp({
      configured: true, withRepo: true, sessions: sessionFor(null), githubApp: { connected: true, prs: [] }, e2eEnv: gh.env
    })
    const inbox = await openInboxPr(window)
    await window.setViewportSize({ width: 1440, height: 900 })
    const writes = githubServer.operations.length
    await expect(inbox.getByText("1/1 passing").or(inbox.getByText("Reviewers", { exact: true }))).toBeVisible()
    await inbox.getByRole("button", { name: "Review", exact: true }).click()
    const drawer = window.getByRole("complementary", { name: "Review #42" })
    await expect(drawer).toBeVisible()
    await expect(drawer.getByText("Read-only", { exact: true })).toBeVisible()
    await expect(drawer.getByRole("button", { name: "Promote to session" })).toBeDisabled()
    await expect(inbox.getByText("Reviewers", { exact: true })).toHaveCount(0)
    await expect(drawer.getByTestId("review-draft")).toHaveCount(2)

    await drawer.getByTestId("review-draft").first().getByRole("button", { name: "Add to review" }).click()
    await expect(inbox.getByTestId("pr-pending-comments")).toContainText("src/auth.ts:42")
    await drawer.getByRole("button", { name: "Close review drawer" }).click()
    await expect(drawer).toHaveCount(0)
    await inbox.getByRole("button", { name: "Review", exact: true }).click()
    await expect(drawer.getByTestId("review-draft")).toHaveCount(2)
    await window.keyboard.press("Escape")
    await expect(drawer).toHaveCount(0)
    await expect(inbox.getByTestId("pr-pending-comments")).toContainText("src/auth.ts:42")
    expect(githubServer.operations.filter((op) => op.startsWith("pr review"))).toHaveLength(0)
    expect(githubServer.operations).toHaveLength(writes)
  } finally { rmSync(gh.root, { recursive: true, force: true }) }
})

test("Review button is absent on a PR linked to a session", async ({ launchApp }) => {
  test.setTimeout(120_000)
  const gh = installGh()
  try {
    const { window } = await launchApp({
      configured: true, withRepo: true, sessions: sessionFor(42), githubApp: { connected: true, prs: [] }, e2eEnv: gh.env
    })
    const inbox = await openInboxPr(window)
    await expect(inbox.getByRole("button", { name: "Open session" })).toBeVisible()
    await expect(inbox.getByRole("button", { name: "Review", exact: true })).toHaveCount(0)
  } finally { rmSync(gh.root, { recursive: true, force: true }) }
})
