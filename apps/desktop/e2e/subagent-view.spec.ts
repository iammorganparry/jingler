import { appShell, expect, test } from "./fixtures.js"
import type { SeedSession } from "./fixtures.js"

const seededSessions = ({ repoPath }: { repoPath: string }): ReadonlyArray<SeedSession> => [{
  id: "s_subagent_view",
  repo: "widget",
  branch: "chore/subagent-view",
  title: "Sub-agent view session",
  status: "idle",
  diff: { added: 0, removed: 0 },
  prNumber: null,
  costUsd: 0,
  tokens: 0,
  updatedAt: "2026-07-26T10:00:00.000Z",
  worktreePath: repoPath,
  mode: "accept-edits"
}]

test("a subagent swaps into the chat lane in place; sibling switch and back keep the main draft", async ({
  launchApp
}) => {
  const { window } = await launchApp({ configured: true, withRepo: true, sessions: seededSessions })
  await expect(appShell(window)).toBeVisible()

  const composer = window.getByPlaceholder("Message the agent…")
  await composer.fill("[[held-subagents]] survey the app")
  await composer.press("Enter")
  await expect(window.getByTestId("subagent-chip").first()).toBeVisible({ timeout: 15_000 })

  // Main draft typed before the swap must survive the round trip.
  await composer.fill("half-written main draft")
  const groups = window.getByTestId("editor-group")
  const groupCount = await groups.count()
  await expect(window.getByTestId("conversation-scroll")).toHaveCount(1)
  await expect(window.getByTestId("subagent-breadcrumb")).toHaveCount(0)

  await window.getByRole("button", { name: "View", exact: true }).first().click()
  const view = window.getByTestId("fleet-agent-transcript")
  await expect(view).toContainText("Survey the tab bar")
  // Same lane: main transcript is replaced, no editor group appears.
  await expect(window.getByTestId("conversation-scroll")).toHaveCount(0)
  await expect(groups).toHaveCount(groupCount)
  await expect(window.getByTestId("subagent-breadcrumb")).toContainText("survey the app")

  // ▾ switches to the sibling without going back to main.
  await window.getByTestId("subagent-crumb").click()
  await window.getByRole("menuitem", { name: /Audit the theme tokens/ }).click()
  await expect(view).toContainText("Audit the theme tokens")
  await expect(window.getByTestId("subagent-breadcrumb")).toBeVisible()
  await expect(groups).toHaveCount(groupCount)

  // ← Main returns with the draft intact.
  await window.getByTestId("subagent-back").click()
  await expect(window.getByTestId("subagent-breadcrumb")).toHaveCount(0)
  await expect(view).toHaveCount(0)
  await expect(window.getByPlaceholder("Message the agent…")).toHaveValue("half-written main draft")

  // Esc returns too.
  await window.getByTestId("subagent-chip").first().click()
  await window.getByTestId("subagent-chip-popover").getByRole("menuitem", { name: /Survey the tab bar/ }).click()
  await expect(view).toContainText("Survey the tab bar")
  await window.keyboard.press("Escape")
  await expect(window.getByTestId("subagent-breadcrumb")).toHaveCount(0)
  await expect(window.getByPlaceholder("Message the agent…")).toHaveValue("half-written main draft")
  await expect(groups).toHaveCount(groupCount)
})
