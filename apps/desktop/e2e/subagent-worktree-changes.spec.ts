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
