import { appShell, expect, test, type SeedSession } from "./fixtures.js"

const seededSessions = ({ repoPath }: { repoPath: string }): ReadonlyArray<SeedSession> => [
  {
    id: "s_approval_auto_switch",
    repo: "widget",
    branch: "feat/approval-auto",
    title: "Test approval gate auto switch",
    status: "idle",
    diff: { added: 0, removed: 0 },
    prNumber: null,
    costUsd: 0,
    tokens: 0,
    updatedAt: "2026-10-12T00:00:00.000Z",
    worktreePath: repoPath,
    mode: "accept-edits"
  }
]

test("Switch session to Auto link changes the session mode", async ({ launchApp }) => {
  const { window } = await launchApp({
    configured: true,
    withRepo: true,
    sessions: seededSessions
  })

  await expect(appShell(window)).toBeVisible()

  // Session starts in accept-edits mode
  await expect(window.getByRole("button", { name: "Accept Edits", exact: true })).toBeVisible()

  const composer = window.getByPlaceholder("Message the agent…")
  await composer.click()
  await composer.pressSequentially("Add rate limiting to the settings endpoint.")
  await composer.press("Enter")

  // accept-edits mode: the edit auto-applies, but the shell command pauses for HITL
  await expect(window.getByText("Approval needed · run a command")).toBeVisible({ timeout: 20_000 })

  // The "Switch session to Auto" link should be visible
  const switchLink = window.getByRole("button", { name: "Switch session to Auto" })
  await expect(switchLink).toBeVisible()

  // Click the link
  await switchLink.click()

  // The mode chip should now show "Auto"
  await expect(window.getByRole("button", { name: "Auto", exact: true })).toBeVisible({ timeout: 5_000 })

  // The approval gate should still be visible (the mode change doesn't auto-approve pending gates)
  await expect(window.getByText("Approval needed · run a command")).toBeVisible()
  await expect(window.getByRole("button", { name: /Allow once/ })).toBeVisible()
})
