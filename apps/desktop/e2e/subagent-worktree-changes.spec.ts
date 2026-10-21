import { execFileSync } from "node:child_process"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { appShell, expect, test } from "./fixtures.js"
import type { SeedSession } from "./fixtures.js"

const seededSessions = ({ repoPath }: { repoPath: string }): ReadonlyArray<SeedSession> => [{
  id: "s_child_pr",
  repo: "widget",
  branch: "chore/child-pr",
  title: "Child PR session",
  status: "idle",
  diff: { added: 0, removed: 0 },
  prNumber: 482,
  costUsd: 0,
  tokens: 0,
  updatedAt: "2026-07-26T10:00:00.000Z",
  worktreePath: repoPath,
  mode: "accept-edits"
}]

test("#561: a child that opens a PR appears in the header PRs chip without a reload", async ({ launchApp }) => {
  const { window } = await launchApp({ configured: true, withRepo: true, sessions: seededSessions })
  await expect(appShell(window)).toBeVisible()

  const composer = window.getByPlaceholder("Message the agent…")
  await composer.fill("[[held-subagents]] [[held-settles]] survey the app")
  await composer.press("Enter")
  await expect(window.getByTestId("subagent-chip").first()).toBeVisible({ timeout: 15_000 })

  // Children settle on their own and the settled child carries PR #491.
  const chip = window.getByTestId("session-prs-chip")
  await expect(chip).toContainText("PRs · 2", { timeout: 30_000 })
  await chip.click()
  await expect(window.getByTestId("session-prs-chip-row-491")).toContainText("Explore")
})

test("#560: Changes agent scope aggregates a child's worktree, filters to it, and Main hides it", async ({ launchApp }) => {
  const childTree = mkdtempSync(join(tmpdir(), "jingler-child-tree-"))
  try {
    execFileSync("git", ["init", "-b", "main"], { cwd: childTree })
    execFileSync("git", ["config", "user.email", "e2e@jingler.dev"], { cwd: childTree })
    execFileSync("git", ["config", "user.name", "Jingler E2E"], { cwd: childTree })
    writeFileSync(join(childTree, "child.txt"), "one\n")
    execFileSync("git", ["add", "-A"], { cwd: childTree })
    execFileSync("git", ["commit", "-m", "init", "--no-gpg-sign"], { cwd: childTree })
    writeFileSync(join(childTree, "child.txt"), "two\n")

    const { window } = await launchApp({
      configured: true,
      withRepo: true,
      sessions: seededSessions,
      e2eEnv: { JINGLER_E2E_SUBAGENT_WORKSPACE: childTree },
      seed: ({ repoPath }) => writeFileSync(join(repoPath, "README.md"), "# e2e repo\nmain change\n")
    })
    await expect(appShell(window)).toBeVisible()
    const composer = window.getByPlaceholder("Message the agent…")
    await composer.fill("[[held-subagents]] survey the app")
    await composer.press("Enter")
    await expect(window.getByTestId("subagent-chip").first()).toBeVisible({ timeout: 15_000 })

    await window.getByRole("button", { name: "Changes" }).first().click()
    const list = window.getByRole("listbox", { name: "Changed files by agent" })
    await expect(list.getByRole("option", { name: /child\.txt/ })).toBeVisible({ timeout: 30_000 })
    await expect(list.getByRole("option", { name: /README\.md/ })).toBeVisible()

    const filter = window.getByRole("button", { name: "Filter by agent" })
    await filter.click()
    await window.getByRole("option", { name: "Survey the tab bar", exact: true }).click()
    await expect(list.getByRole("option", { name: /child\.txt/ })).toBeVisible()
    await expect(list.getByRole("option", { name: /README\.md/ })).toHaveCount(0)

    await filter.click()
    await window.getByRole("option", { name: "Main", exact: true }).click()
    await expect(list.getByRole("option", { name: /README\.md/ })).toBeVisible()
    await expect(list.getByRole("option", { name: /child\.txt/ })).toHaveCount(0)
  } finally {
    rmSync(childTree, { recursive: true, force: true })
  }
})
