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
  // #460: finished children live in the lane-header chip's popover ("Finished · N").
  await window.getByTestId("subagent-chip").first().click()
}

test("completed compatibility-agent output remains in Previous chats", async ({
  launchApp
}) => {
  const { window } = await launchApp({ configured: true, withRepo: true, sessions: seededSessions })
  await expect(appShell(window)).toBeVisible()

  await window.getByPlaceholder("Message the agent…").fill("[[legacy-agent]] inspect compatibility")
  await window.getByPlaceholder("Message the agent…").press("Enter")
  await expect(window.getByTestId("subagent-chip").first()).toBeVisible({
    timeout: 15_000
  })
  await openPreviousChats(window)
  const previous = window.getByTestId("subagent-chip-popover").getByRole("menuitem", { name: /Legacy Scout/ })
  await expect(previous).toBeVisible()
  await previous.click()
  await expect(window.getByTestId("fleet-agent-transcript")).toContainText(
    "Legacy transcript remains visible in Fleet."
  )
})

test("spawning shows the chip and transcript row, and View and a popover row open the same subagent", async ({
  launchApp
}) => {
  const { window } = await launchApp({ configured: true, withRepo: true, sessions: seededSessions })
  await expect(appShell(window)).toBeVisible()

  await window.getByPlaceholder("Message the agent…").fill("[[held-subagents]] survey the app")
  await window.getByPlaceholder("Message the agent…").press("Enter")

  // #460: entry points are visible without opening the fleet.
  await expect(window.getByTestId("subagent-chip").first()).toBeVisible({ timeout: 15_000 })
  await expect(window.getByTestId("subagent-spawn-row")).toContainText("Spawned 2 subagents")
  await expect(window.getByTestId("fleet-agent-transcript")).toHaveCount(0)

  await window.getByRole("button", { name: "View", exact: true }).click()
  const view = window.getByTestId("fleet-agent-transcript")
  await expect(view).toContainText("Survey the tab bar")

  // A popover row opens a child; opening the first row again lands on the same child View opened.
  const popover = window.getByTestId("subagent-chip-popover")
  await window.getByTestId("subagent-chip").first().click()
  await popover.getByRole("menuitem", { name: /Audit the theme tokens/ }).click()
  await expect(view).toContainText("Audit the theme tokens")
  await window.getByTestId("subagent-chip").first().click()
  await popover.getByRole("menuitem", { name: /Survey the tab bar/ }).click()
  await expect(view).toContainText("Survey the tab bar")
})
