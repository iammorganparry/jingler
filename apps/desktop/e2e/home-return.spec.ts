import { appShell, expect, test } from "./fixtures.js"

/** QA Q15/Q16: closing the last pane returns to Home, and a sidebar row reopens the session. */
test("closing the last pane returns to Home and the session row reopens it", async ({ launchApp }) => {
  const { window } = await launchApp({
    configured: true,
    isolateSystemHome: true,
    withRepo: true,
    sessions: ({ repoPath }) => [
      {
        id: "s_home",
        repo: "widget",
        repoPath,
        title: "Home return session",
        branch: "main",
        status: "idle",
        diff: { added: 0, removed: 0 },
        prNumber: null,
        costUsd: 0,
        tokens: 0,
        updatedAt: "2026-10-01T00:00:00.000Z",
        worktreePath: repoPath,
        workspaceMode: "direct",
        mode: "auto"
      }
    ]
  })
  await expect(appShell(window)).toBeVisible()
  const row = window.getByTestId("session-row-s_home")
  await row.click()
  await expect(window.getByTestId("editor-groups")).toBeVisible()

  await window.keyboard.press("Control+Shift+W")
  await expect(window.getByTestId("home-starters")).toBeVisible()
  await expect(window.getByTestId("editor-groups-empty")).toHaveCount(0)

  await row.click()
  await expect(window.getByTestId("editor-groups")).toBeVisible()
  await expect(window.getByTestId("composer").first()).toBeVisible()
})
