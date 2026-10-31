import { appShell, expect, test } from "./fixtures.js"
import type { SeedSession } from "./fixtures.js"

/**
 * "Watch in terminal" on an agent's command card opens a read-only terminal tab
 * mirroring that command's output. The deterministic agent runs
 * `printf '1 passed\n'` in Auto mode; we assert on the tab chrome, not the xterm
 * canvas (its text isn't in the DOM).
 */

const seededSessions = ({ repoPath }: { repoPath: string }): ReadonlyArray<SeedSession> => [
  {
    id: "s_seeded",
    repo: "widget",
    branch: "chore/refactor",
    title: "Refactor auth flow",
    status: "idle",
    diff: { added: 0, removed: 0 },
    prNumber: null,
    costUsd: 0,
    tokens: 0,
    updatedAt: "2026-07-11T00:00:00.000Z",
    worktreePath: repoPath,
    mode: "accept-edits"
  }
]

test("an agent command opens in a read-only terminal tab", async ({ launchApp }) => {
  const { window } = await launchApp({ configured: true, withRepo: true, sessions: seededSessions })
  await expect(appShell(window)).toBeVisible()

  const composer = window.getByPlaceholder("Message the agent…")
  await composer.click()
  await window.getByRole("button", { name: "Accept Edits", exact: true }).click()
  await window.getByRole("option", { name: /^Auto\b/ }).click()
  await composer.pressSequentially("Add rate limiting.")
  await composer.press("Enter")
  await expect(window.getByText("Implemented rate limiting and verified 1 passed.")).toBeVisible({ timeout: 25_000 })

  const watch = window.getByRole("button", { name: "Watch in terminal" })
  // The card may have mounted already settled (collapsed); open it to reach its actions.
  if (!(await watch.first().isVisible())) await window.getByText("printf '1 passed\\n'").first().click()
  await watch.first().click()

  await expect(window.getByRole("tab", { name: /^printf/ })).toBeVisible({ timeout: 10_000 })
  await expect(window.locator(".xterm").first()).toBeVisible({ timeout: 10_000 })
  await expect(window.getByTestId("terminal-exited")).toContainText("Agent command finished")
  // A mirror has nothing to restart.
  await expect(window.getByTestId("terminal-exited").getByRole("button", { name: "Restart" })).toHaveCount(0)
})
