import { appShell, expect, test } from "./fixtures.js"
import type { SeedSession } from "./fixtures.js"

const seededSessions = ({ repoPath }: { repoPath: string }): ReadonlyArray<SeedSession> => [{
  id: "s_subagents",
  repo: "widget",
  branch: "chore/subagents-outlive",
  title: "Sub-agent session",
  status: "idle",
  diff: { added: 0, removed: 0 },
  prNumber: null,
  costUsd: 0,
  tokens: 0,
  updatedAt: "2026-07-26T10:00:00.000Z",
  worktreePath: repoPath,
  mode: "accept-edits"
}]

const openPreviousChats = async (window: Parameters<typeof appShell>[0]) => {
  await window.getByRole("button", { name: "Previous subagents" }).click()
}

test("completed compatibility-agent output remains in Previous chats", async ({
  launchApp
}) => {
  const { window } = await launchApp({ configured: true, withRepo: true, sessions: seededSessions })
  await expect(appShell(window)).toBeVisible()

  await window.getByPlaceholder("Message the agent…").fill("[[legacy-agent]] inspect compatibility")
  await window.getByPlaceholder("Message the agent…").press("Enter")
  await expect(window.getByRole("button", { name: "Previous subagents" })).toBeVisible({
    timeout: 15_000
  })
  await openPreviousChats(window)
  const previous = window.getByRole("menuitem", { name: /Open Legacy Scout/ })
  await expect(previous).toBeVisible()
  await previous.click()
  await expect(window.getByTestId("fleet-agent-transcript")).toContainText(
    "Legacy transcript remains visible in Fleet."
  )
})
