import { execFileSync } from "node:child_process"
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { appShell, expect, test } from "./fixtures.js"

test("QA Q20: Changes refreshes live when the agent's file edit lands, without a manual refresh", async ({ launchApp }) => {
  const { window } = await launchApp({
    configured: true,
    isolateSystemHome: true,
    withRepo: true,
    sessions: ({ repoPath }) => [{
      id: "s_live_changes",
      repo: "widget",
      branch: "jingler/live-changes",
      title: "Live changes",
      status: "idle",
      diff: { added: 0, removed: 0 },
      prNumber: null,
      costUsd: 0,
      tokens: 0,
      updatedAt: "2026-08-08T00:00:00.000Z",
      worktreePath: repoPath,
      mode: "auto"
    }],
    seed: ({ repoPath }) => {
      mkdirSync(join(repoPath, "src"), { recursive: true })
      writeFileSync(join(repoPath, "src", "other.ts"), "export const other = true\n")
      execFileSync("git", ["add", "-A"], { cwd: repoPath })
      execFileSync("git", ["commit", "-m", "seed", "--no-gpg-sign"], { cwd: repoPath })
    }
  })
  await expect(appShell(window)).toBeVisible()
  await window.getByRole("button", { name: "Changes" }).first().click()
  const explorer = window.getByTestId("changed-files-explorer")
  await expect(explorer).toBeVisible({ timeout: 20_000 })
  await expect(explorer.locator('[data-item-path="src/delegated.ts"]')).toHaveCount(0)

  const composer = window.getByPlaceholder("Message the agent…")
  await composer.fill("[[subagent-edit-preview]] Delegate this file update.")
  await composer.press("Enter")

  await expect(explorer.locator('[data-item-path="src/delegated.ts"]')).toBeVisible({ timeout: 30_000 })
})
