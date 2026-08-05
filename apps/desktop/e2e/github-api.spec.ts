import { execFileSync, spawnSync } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { appShell, expect, test } from "./fixtures.js"

/**
 * Proves the built app's GitHub surface against HTTP with no `gh` executable on
 * PATH. Unit tests pin every payload; this covers the integration boundary that
 * used to regress when an RPC handler quietly reached back for a CLI adapter.
 */
test("GitHub App API browses and checks out a fork PR without GitHub CLI", async ({
  launchApp
}) => {
  const launched = await launchApp({
    configured: true,
    withRepo: true,
    withoutGithubCli: true,
    seed: ({ repoPath }) => {
      execFileSync("git", ["branch", "feature/from-fork", "main"], { cwd: repoPath })
    },
    githubApp: {
      connected: true,
      userLogin: "e2e-user",
      accountLogin: "acme",
      prs: [
        {
          number: 482,
          title: "Fix auth refresh race",
          headRefName: "feature/from-fork",
          baseRefName: "main",
          author: { login: "contributor" },
          additions: 31,
          deletions: 4,
          body: "## Why\n\nRefreshes could race.",
          checks: [{ name: "build", conclusion: "success" }],
          headRepository: { id: 777, fullName: "contributor/widget" }
        }
      ]
    }
  })

  const { app, window, home, githubServer } = launched
  await expect(appShell(window)).toBeVisible()
  const runtimePath = await app.evaluate(() => process.env.PATH ?? "")
  const ghProbe = spawnSync("gh", ["--version"], {
    env: { ...process.env, PATH: runtimePath }
  })
  expect((ghProbe.error as NodeJS.ErrnoException | undefined)?.code).toBe("ENOENT")
  await window.getByTestId("new-session").click()
  await window.getByRole("tab", { name: "From PR" }).click()

  await expect(window.getByText("Fix auth refresh race")).toBeVisible()
  await window.getByText("Fix auth refresh race").click()
  await window.getByRole("button", { name: "Create" }).click()
  await expect(window.getByText("⑂ #482")).toBeVisible()

  const worktreePath = join(
    home,
    "jingler",
    "worktrees",
    "widget",
    "fix-auth-refresh-race-482"
  )
  expect(existsSync(worktreePath)).toBe(true)
  expect(
    execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
      cwd: worktreePath,
      encoding: "utf8"
    }).trim()
  ).toBe("feature/from-fork")

  await window.getByRole("button", { name: "Pull Request" }).click()
  await expect(window.getByRole("heading", { name: "Why" })).toBeVisible()
  await expect(window.getByText("build")).toBeVisible()
  await window.getByRole("radio", { name: "Squash" }).click()
  await window.getByRole("button", { name: "Squash and merge" }).click()
  await expect
    .poll(() => githubServer.operations)
    .toContain("pr merge 482 --squash")

  const rendererState = await window.evaluate(() => ({
    html: document.body.innerHTML,
    localStorage: JSON.stringify({ ...localStorage })
  }))
  expect(JSON.stringify(rendererState)).not.toContain("e2e-short-lived-github-grant")

  const persisted = JSON.parse(
    readFileSync(join(home, "jingler", "sessions.json"), "utf8")
  ) as ReadonlyArray<Record<string, unknown>>
  expect(persisted[0]).toMatchObject({
    branch: "feature/from-fork",
    prNumber: 482,
    baseBranch: "main"
  })
  expect(githubServer.requests.some((request) => request.path.includes("/pulls/482"))).toBe(true)
})

test("GitHub App API lists and opens an issue without GitHub CLI", async ({ launchApp }) => {
  const { window, home, githubServer } = await launchApp({
    configured: true,
    withRepo: true,
    withoutGithubCli: true,
    githubApp: {
      connected: true,
      userLogin: "e2e-user",
      accountLogin: "acme",
      issues: [
        {
          number: 128,
          title: "Refund route 500s on a stale token",
          body: "Refresh and retry the request.",
          author: { login: "mira" },
          assignees: [{ login: "e2e-user" }]
        }
      ]
    }
  })

  await expect(appShell(window)).toBeVisible()
  await window.getByTestId("new-session").click()
  await window.getByRole("tab", { name: "From issue" }).click()
  await window.getByRole("switch", { name: "Only issues assigned to me" }).click()
  await expect(window.getByText("Refund route 500s on a stale token")).toBeVisible()
  await window.getByText("Refund route 500s on a stale token").click()
  await window.getByRole("button", { name: "Start on #128" }).click()
  await window.getByRole("button", { name: "Create session" }).click()
  await expect(window.getByText("◉ #128")).toBeVisible()

  const persisted = JSON.parse(
    readFileSync(join(home, "jingler", "sessions.json"), "utf8")
  ) as ReadonlyArray<Record<string, unknown>>
  expect(persisted[0]).toMatchObject({ issueNumber: 128, repo: "widget" })
  expect(githubServer.requests.some((request) => request.path.endsWith("/issues"))).toBe(true)
})
