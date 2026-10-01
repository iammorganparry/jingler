import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { delimiter, join } from "node:path"
import type { SeedSession } from "./fixtures.js"
import { appShell, expect, test } from "./fixtures.js"

const inbox = [{
  data: {
    viewer: { login: "octocat" },
    search: {
      nodes: [{
        assignees: { nodes: [] }, author: { login: "octocat", avatarUrl: null },
        comments: { totalCount: 0 }, isDraft: false, labels: { nodes: [] }, number: 42,
        repository: { nameWithOwner: "acme/widget" }, reviewRequests: { nodes: [] },
        state: "OPEN", title: "CLI-only pull request", updatedAt: "2026-10-01T08:00:00.000Z",
        url: "https://github.com/acme/widget/pull/42"
      }],
      pageInfo: { hasNextPage: false, endCursor: null }
    }
  }
}]

const pr = {
  state: "OPEN", number: 42, title: "CLI-only pull request",
  body: "Loaded through authenticated GitHub CLI without an App installation.",
  url: "https://github.com/acme/widget/pull/42", author: { login: "octocat" },
  headRefName: "feature", baseRefName: "main", headRefOid: "abc",
  isDraft: false, commits: [], additions: 3, deletions: 1,
  labels: [], reviews: [], comments: [], reviewRequests: [], statusCheckRollup: []
}

const sessions = ({ repoPath }: { repoPath: string }): ReadonlyArray<SeedSession> => [{
  id: "session_cli_pr", repo: "widget", branch: "feature", title: "CLI PR session",
  status: "idle", diff: { added: 3, removed: 1 }, prNumber: null,
  costUsd: 0, tokens: 0, updatedAt: "2026-10-01T08:00:00.000Z",
  worktreePath: repoPath, mode: "accept-edits"
}]

test("links and shows a pull request through authenticated gh without a GitHub App", async ({ launchApp }) => {
  const root = mkdtempSync(join(tmpdir(), "jingler-e2e-gh-"))
  const bin = join(root, "bin")
  const gh = join(bin, "gh")
  try {
    mkdirSync(bin)
    const script = [
      "#!/usr/bin/env node",
      "const args = process.argv.slice(2)",
      "const joined = args.join(' ')",
      `const inbox = ${JSON.stringify(inbox)}`,
      `const pr = ${JSON.stringify(pr)}`,
      "if (args[0] === 'auth' && args[1] === 'status') process.exit(0)",
      "if (args[0] === 'pr' && args[1] === 'view') { console.log(JSON.stringify(joined.includes('number,state') ? { number: 42, state: 'OPEN' } : pr)); process.exit(0) }",
      "if (args[0] === 'repo' && args[1] === 'view') { console.log('acme/widget'); process.exit(0) }",
      "if (args[0] === 'api' && args[1] === 'repos/acme/widget') { console.log(JSON.stringify({ id: 7, node_id: 'R_7' })); process.exit(0) }",
      "if (args[0] === 'api' && args[1] === 'repos/acme/widget/pulls/42/files') { console.log('[[]]'); process.exit(0) }",
      "if (args[0] === 'api' && args[1] === 'graphql') {",
      "  if (joined.includes('search(query:')) console.log(JSON.stringify(inbox))",
      "  else if (joined.includes('commits(first:100')) console.log(JSON.stringify([{ data: { repository: { pullRequest: { commits: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } } } } }]))",
      "  else console.log(JSON.stringify([{ data: { repository: { pullRequest: { reviewThreads: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } } } } }]))",
      "  process.exit(0)",
      "}",
      "console.error('unsupported gh command: ' + joined)",
      "process.exit(1)"
    ].join("\n")
    writeFileSync(gh, script)
    chmodSync(gh, 0o755)

    const { window } = await launchApp({
      configured: true,
      withRepo: true,
      sessions,
      e2eEnv: { PATH: `${bin}${delimiter}${process.env.PATH ?? ""}` }
    })

    await expect(appShell(window)).toBeVisible()
    await expect(window.getByText("#42", { exact: true }).first()).toBeVisible({ timeout: 20_000 })
    await window.getByTestId("view-tab-pr").first().click()
    await expect(window.getByRole("heading", { name: "CLI-only pull request" })).toBeVisible()
    await expect(window.getByText("Loaded through authenticated GitHub CLI without an App installation.")).toBeVisible()
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
