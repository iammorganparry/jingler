import { execFileSync } from "node:child_process"
import { resolve } from "node:path"
import { appShell, expect, test } from "./fixtures.js"

test("isolated subagent: its file shows under the child checkout, not Main, in its own worktree", async ({ launchApp }) => {
  const { window, repoPath } = await launchApp({
    configured: true,
    e2eEnv: { JINGLER_SUBAGENT_PROCESS_WORKER: resolve(import.meta.dirname, "isolated-subagent-process-worker.mjs") },
    withRepo: true,
    sessions: ({ repoPath: worktreePath }) => [{
      id: "s_isolated",
      repo: "widget",
      branch: "chore/isolated",
      title: "Isolated child",
      status: "idle",
      diff: { added: 0, removed: 0 },
      prNumber: null,
      costUsd: 0,
      tokens: 0,
      updatedAt: "2026-07-26T10:00:00.000Z",
      worktreePath,
      mode: "auto"
    }]
  })
  await expect(appShell(window)).toBeVisible()
  const composer = window.getByPlaceholder("Message the agent…")
  await composer.fill("[[isolated-subagent]] write the file in an isolated checkout")
  await composer.press("Enter")

  await window.getByRole("button", { name: "Changes" }).first().click()
  const list = window.getByRole("listbox", { name: "Changed files by agent" })
  await expect(list.getByRole("option", { name: /isolated\.ts/ })).toBeVisible({ timeout: 60_000 })

  const filter = window.getByRole("button", { name: "Filter by agent" })
  await filter.click()
  await window.getByRole("option", { name: "Main", exact: true }).click()
  await expect(list.getByRole("option", { name: /isolated\.ts/ })).toHaveCount(0)

  // In Pi, pi-subagents owns isolation: its child checkout is a separate git worktree.
  const worktrees = execFileSync("git", ["worktree", "list"], { cwd: repoPath, encoding: "utf8" })
  expect(worktrees).toContain("pi-worktree-")
})
