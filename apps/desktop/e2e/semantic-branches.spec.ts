import { execFileSync } from "node:child_process"
import { readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { appShell, createWorkspace, expect, test } from "./fixtures.js"

const sessions = (home: string): Array<{
  title: string
  branch: string
  worktreePath: string
  semanticBranchPending?: boolean
  semanticBranchProposal?: { type: string; slug: string }
}> => JSON.parse(readFileSync(join(home, "jingler", "sessions.json"), "utf8"))

const git = (cwd: string, args: ReadonlyArray<string>): string =>
  execFileSync("git", [...args], { cwd, encoding: "utf8" }).trim()

test("a fresh task starts detached and becomes a visible collision-safe semantic branch", async ({
  launchApp
}) => {
  const { window, home, repoPath } = await launchApp({
    configured: true,
    withRepo: true
  })
  const staleLocalBase = git(repoPath, ["rev-parse", "main"])
  const remotePath = join(home, "semantic-origin.git")
  const writerPath = join(home, "semantic-origin-writer")
  execFileSync("git", ["clone", "--bare", repoPath, remotePath])
  execFileSync("git", ["remote", "add", "origin", remotePath], { cwd: repoPath })
  execFileSync("git", ["clone", remotePath, writerPath])
  execFileSync("git", ["config", "user.email", "e2e@example.com"], { cwd: writerPath })
  execFileSync("git", ["config", "user.name", "Jingler E2E"], { cwd: writerPath })
  writeFileSync(join(writerPath, "remote-base.txt"), "new remote base\n")
  execFileSync("git", ["add", "remote-base.txt"], { cwd: writerPath })
  execFileSync("git", ["commit", "-m", "advance remote base", "--no-gpg-sign"], {
    cwd: writerPath
  })
  execFileSync("git", ["push", "origin", "main"], { cwd: writerPath })
  const updatedBaseSha = git(remotePath, ["rev-parse", "main"])
  expect(updatedBaseSha).not.toBe(staleLocalBase)

  await expect(appShell(window)).toBeVisible()
  await createWorkspace(window, "Fix token refresh", "worktree", repoPath)
  await expect(window.locator("[data-testid^='session-row-']")).toHaveCount(1)
  const composerBranch = window.getByTestId("composer-branch")
  await expect(composerBranch).toHaveText("Naming branch…")

  const staged = sessions(home)[0]!
  expect(staged).toMatchObject({
    branch: "main",
    semanticBranchPending: true
  })
  expect(git(staged.worktreePath, ["rev-parse", "--abbrev-ref", "HEAD"])).toBe("HEAD")
  expect(git(staged.worktreePath, ["rev-parse", "HEAD"])).toBe(updatedBaseSha)
  expect(git(repoPath, ["rev-parse", "main"])).toBe(staleLocalBase)

  // The scripted title generator deterministically falls back to this semantic
  // proposal. Reserve it first to prove Jingler checks collisions before switch.
  execFileSync("git", ["branch", "chore/fix-token-refresh"], { cwd: repoPath })

  const composer = window.getByPlaceholder("Message the agent…")
  await composer.fill("Fix token refresh")
  await composer.press("Enter")
  await expect(
    window.getByText("Completed through deterministic pi. Repository summary: src/routes/billing.ts.")
  ).toBeVisible({ timeout: 25_000 })

  await expect(composerBranch).toHaveText("chore/fix-token-refresh-2", {
    timeout: 20_000
  })
  await expect.poll(() => sessions(home)[0]?.branch).toBe("chore/fix-token-refresh-2")
  const named = sessions(home)[0]!
  expect(named).toMatchObject({
    title: "Fix token refresh",
    branch: "chore/fix-token-refresh-2",
    semanticBranchPending: false,
    semanticBranchProposal: { type: "chore", slug: "fix-token-refresh" }
  })
  expect(git(named.worktreePath, ["rev-parse", "--abbrev-ref", "HEAD"])).toBe(
    "chore/fix-token-refresh-2"
  )
  expect(git(repoPath, ["branch", "--list", "jingler/*"])).toBe("")
  await expect(
    window.getByTitle("Working branch: chore/fix-token-refresh-2")
  ).toBeVisible()
})
