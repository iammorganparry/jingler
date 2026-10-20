import { appShell, expect, test } from "./fixtures.js"
import type { SeedSession } from "./fixtures.js"

const askSeededSessions = ({ repoPath }: { repoPath: string }): ReadonlyArray<SeedSession> => [
  {
    id: "s_subagents_ask",
    repo: "widget",
    branch: "chore/subagents-outlive-ask",
    title: "Sub-agent question session",
    status: "idle",
    diff: { added: 0, removed: 0 },
    prNumber: null,
    costUsd: 0,
    tokens: 0,
    updatedAt: "2026-07-26T10:00:00.000Z",
    worktreePath: repoPath,
    mode: "accept-edits"
  },
  {
    id: "s_quiet",
    repo: "alpha",
    branch: "main",
    title: "Quiet session",
    status: "idle",
    diff: { added: 0, removed: 0 },
    prNumber: null,
    costUsd: 0,
    tokens: 0,
    updatedAt: "2026-07-26T09:00:00.000Z",
    worktreePath: repoPath,
    mode: "accept-edits"
  }
]

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
  // #460: finished children live in the lane-header chip's popover ("Done (N)").
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

  // The fixture emits start + end tool calls, so two cards carry View; both open the same child.
  await window.getByRole("button", { name: "View", exact: true }).first().click()
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

test("sidebar shows the running agent count and ⌘K Go to subagent… opens a child", async ({
  launchApp
}) => {
  const { window } = await launchApp({ configured: true, withRepo: true, sessions: seededSessions })
  await expect(appShell(window)).toBeVisible()

  await window.getByPlaceholder("Message the agent…").fill("[[held-subagents]] survey the app")
  await window.getByPlaceholder("Message the agent…").press("Enter")
  await expect(window.getByTestId("subagent-chip").first()).toBeVisible({ timeout: 15_000 })

  await expect(window.getByTestId("session-subagent-count-s_subagents")).toHaveText("· 2 agents")
  await expect(window.getByTestId("fleet-agent-transcript")).toHaveCount(0)

  await window.keyboard.press("ControlOrMeta+k")
  const palette = window.getByRole("dialog", { name: "Command palette" })
  await palette.getByPlaceholder(/Jump to a session/).fill("Go to subagent")
  await palette.getByRole("option", { name: /Survey the tab bar/ }).click()
  await expect(window.getByTestId("fleet-agent-transcript")).toContainText("Survey the tab bar")
})

test("#509: a held subagent's question bumps the sidebar needs-you count and lights the latest turn's rail tick", async ({
  launchApp
}) => {
  const { window } = await launchApp({ configured: true, withRepo: true, sessions: askSeededSessions })
  await expect(appShell(window)).toBeVisible()
  await window.setViewportSize({ width: 1500, height: 860 })

  const projects = window.getByTestId("project-sidebar")
  await projects.getByRole("button", { name: "widget", exact: true }).click()

  await window.getByPlaceholder("Message the agent…").fill("[[held-subagent-asks]] survey the app")
  await window.getByPlaceholder("Message the agent…").press("Enter")
  await expect(window.getByTestId("subagent-chip").first()).toBeVisible({ timeout: 15_000 })

  // Sidebar needs-you badge: viewing another project, the blocked one's tile carries the count.
  await projects.getByRole("button", { name: "Unassigned", exact: true }).click()
  const badge = projects.locator('[data-testid^="project-needs-you-"]')
  await expect(badge).toHaveText("1")
  await expect(badge).toHaveAccessibleName("widget: 1 needs you")

  // Latest turn's rail tick is amber for the pending subagent question.
  await projects.getByRole("button", { name: "widget", exact: true }).click()
  const rail = window.getByRole("navigation", { name: "Message navigation" })
  const tick = rail.locator('[data-slot="preview-rail-item"]').last()
  await expect(tick.locator('[data-slot="preview-rail-tick"]')).toHaveAttribute("data-kind", "needs-you")

  // Opening the subagent shows the QuestionCard for its pending attention request.
  await window.getByRole("button", { name: "View", exact: true }).first().click()
  const view = window.getByTestId("fleet-agent-transcript")
  await expect(view).toContainText("Survey the tab bar")
  await expect(window.getByTestId("subagent-attention")).toBeVisible()
  await expect(window.getByTestId("subagent-attention")).toContainText(
    "Should I include the archived tabs in the tab bar survey?"
  )
})
