import { execFileSync } from "node:child_process"
import { appShell, expect, sessionRow, test } from "./fixtures.js"

const seedSession = ({ repoPath }: { repoPath: string }) => [
  {
    id: "s_github_1",
    repo: "widget",
    repoPath,
    branch: "jingler/github-app",
    title: "GitHub integration",
    status: "idle" as const,
    cli: "claude" as const,
    diff: { added: 0, removed: 0 },
    prNumber: null,
    costUsd: 0,
    tokens: 0,
    updatedAt: "2026-08-04T09:00:00.000Z",
    worktreePath: repoPath,
    baseBranch: "main"
  }
]

const chooseFixtureRepo = async (
  app: import("@playwright/test").ElectronApplication,
  reposDir: string
) => {
  await app.evaluate(({ dialog }, selected) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [selected] })
  }, reposDir)
}

test("first-run GitHub is explicitly skippable", async ({ launchApp }) => {
  const { app, window, reposDir } = await launchApp({
    withRepo: true,
    sessions: seedSession,
    seed: ({ repoPath }) => {
      execFileSync("git", ["remote", "add", "origin", "git@github.com:acme/widget.git"], {
        cwd: repoPath
      })
    }
  })
  await chooseFixtureRepo(app, reposDir)
  await window.getByRole("button", { name: "Choose repos folder" }).click()
  await window.getByRole("button", { name: "Continue" }).click()
  await expect(window.getByRole("heading", { name: "Connect GitHub" })).toBeVisible()
  await window.getByRole("button", { name: "Skip for now" }).click()
  await expect(appShell(window)).toBeVisible()
})

test("GitHub onboarding resumes after callback and Settings repairs live access", async ({
  launchApp
}) => {
  const launched = await launchApp({
    withRepo: true,
    sessions: seedSession,
    githubApp: { accountLogin: "acme" },
    seed: ({ repoPath }) => {
      execFileSync("git", ["remote", "add", "origin", "git@github.com:acme/widget.git"], {
        cwd: repoPath
      })
    }
  })
  const { app, window, reposDir, githubServer, completeGitHubConnection } = launched
  await chooseFixtureRepo(app, reposDir)
  await app.evaluate(({ shell }) => {
    ;(globalThis as unknown as { __githubOpened: Array<string> }).__githubOpened = []
    shell.openExternal = async (url: string) => {
      ;(globalThis as unknown as { __githubOpened: Array<string> }).__githubOpened.push(url)
    }
  })

  await window.getByRole("button", { name: "Choose repos folder" }).click()
  await window.getByRole("button", { name: "Continue" }).click()
  await window.getByRole("button", { name: "Install / Connect GitHub" }).click()
  await expect
    .poll(() =>
      app.evaluate(
        () => (globalThis as unknown as { __githubOpened: Array<string> }).__githubOpened
      )
    )
    .toContainEqual(expect.stringContaining("/browser/install"))

  await completeGitHubConnection()
  await expect(appShell(window)).toBeVisible()

  await window.getByRole("button", { name: "Account menu" }).click()
  await window.getByRole("menuitem", { name: "Settings" }).click()
  await window.getByRole("button", { name: /GitHub/ }).click()
  await expect(window.getByText("Connected as @octocat")).toBeVisible()
  await expect(window.getByText("@acme")).toBeVisible()
  await expect(window.getByText("All repositories")).toBeVisible()
  await expect(window.getByText(/GitHub CLI|gh auth|Recheck/i)).toHaveCount(0)

  // Manage goes through the same state-bound install endpoint and callback bridge.
  await window.getByRole("button", { name: "Manage repositories" }).click()
  await expect
    .poll(() => githubServer.requests.filter((request) => request.path === "/api/github/install").length)
    .toBe(2)
  await completeGitHubConnection()
  await expect(window.getByText("Connected as @octocat")).toBeVisible()

  githubServer.setInstallation({
    status: "suspended",
    suspendedAt: "2026-08-04T10:00:00.000Z"
  })
  await window.getByRole("button", { name: "Refresh" }).click()
  await expect(window.getByText("Suspended", { exact: true })).toBeVisible()
  await window.getByRole("button", { name: "Close settings" }).click()

  await sessionRow(window, "GitHub integration").click()
  await window.getByRole("button", { name: "Pull Request", exact: true }).click()
  await expect(window.getByText(/installation for @acme is suspended/i)).toBeVisible()
  await window.getByRole("button", { name: "Repair GitHub access" }).click()
  await expect(window.getByText("Connected as @octocat")).toBeVisible()

  // Moving the installation to another account makes acme/widget provably outside it.
  githubServer.setInstallation({
    account: { id: "202", login: "outside", type: "Organization", avatarUrl: null },
    status: "active",
    suspendedAt: null,
    repositorySelection: "all"
  })
  await window.getByRole("button", { name: "Refresh" }).click()
  await window.getByRole("button", { name: "Close settings" }).click()
  await window.getByRole("button", { name: "Pull Request", exact: true }).click()
  await expect(window.getByText(/acme\/widget is outside the repositories/i)).toBeVisible()
  await expect(window.getByRole("button", { name: "Manage repositories" })).toBeVisible()

  await window.getByRole("button", { name: "Manage repositories" }).click()
  await window.getByRole("button", { name: "Disconnect" }).click()
  await expect(window.getByText("GitHub is not connected")).toBeVisible()
  await expect(window.getByRole("button", { name: "Install / Connect GitHub" })).toBeVisible()
})
