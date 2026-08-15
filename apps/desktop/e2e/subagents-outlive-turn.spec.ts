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

const FIRST_AGENT = /Survey the tab bar/
const SECOND_AGENT = /Audit the theme tokens/

test("Fleet stays composer-adjacent while subagents run and the operator steers Main", async ({
  launchApp
}) => {
  const { window } = await launchApp({ configured: true, withRepo: true, sessions: seededSessions })
  await expect(appShell(window)).toBeVisible()

  const composer = window.getByPlaceholder("Message the agent…")
  await composer.fill("[[held-subagents]] map the UI")
  await composer.press("Enter")

  const fleet = window.getByTestId("fleet-drawer")
  await expect(fleet).toBeVisible({ timeout: 15_000 })
  await expect(fleet.getByRole("button", { name: FIRST_AGENT })).toBeVisible()
  await expect(fleet.getByRole("button", { name: SECOND_AGENT })).toBeVisible()
  await expect(fleet).toContainText("2 active · 2 total")
  await expect(window.getByText("Delegated to two agents.")).toBeVisible()

  const busyComposer = window.getByPlaceholder("Queue a message while the agent works…")
  await busyComposer.fill("also check the theme tokens")
  await busyComposer.press("Enter")
  await expect(window.getByText("Noted: also check the theme tokens")).toBeVisible({
    timeout: 15_000
  })
  await expect(fleet.getByRole("button", { name: FIRST_AGENT })).toBeVisible()
  await expect(fleet.getByRole("button", { name: SECOND_AGENT })).toBeVisible()

  await expect(window.getByText("Both agents reported back.")).toBeVisible({ timeout: 15_000 })
  await expect(fleet).toContainText("0 active · 2 total")
  await expect(window.getByPlaceholder("Message the agent…")).toBeVisible()
})

test("normalized compatibility agents stay inspectable and dismissible in Fleet", async ({
  launchApp
}) => {
  const { window } = await launchApp({ configured: true, withRepo: true, sessions: seededSessions })
  await expect(appShell(window)).toBeVisible()

  await window.getByPlaceholder("Message the agent…").fill("[[legacy-agent]] inspect compatibility")
  await window.getByPlaceholder("Message the agent…").press("Enter")

  const fleet = window.getByTestId("fleet-drawer")
  const legacy = fleet.getByRole("button", { name: /Legacy Scout/ })
  await expect(legacy).toBeVisible({ timeout: 15_000 })
  await legacy.click()
  await expect(window.getByTestId("fleet-agent-transcript")).toContainText(
    "Legacy transcript remains visible in Fleet."
  )
  await expect(fleet.getByTestId(/fleet-agent-legacy:/)).toHaveAttribute(
    "data-agent-status",
    "completed",
    { timeout: 15_000 }
  )
  await fleet.getByRole("button", { name: "Close Legacy Scout" }).click()
  await expect(fleet).toBeHidden()
})

test("selecting a Fleet child shows its session view and Main restores the composer", async ({
  launchApp
}) => {
  const { window } = await launchApp({ configured: true, withRepo: true, sessions: seededSessions })
  await expect(appShell(window)).toBeVisible()

  const composer = window.getByPlaceholder("Message the agent…")
  await composer.fill("[[held-subagents]] map the UI")
  await composer.press("Enter")
  const fleet = window.getByTestId("fleet-drawer")
  const first = fleet.getByRole("button", { name: FIRST_AGENT })
  await expect(first).toBeVisible({ timeout: 15_000 })

  await first.click()
  await expect(window.getByTestId("fleet-agent-transcript")).toBeVisible()
  await expect(window.getByText("The child session transcript is not available yet.")).toBeVisible()
  await expect(window.getByTestId("fleet-drawer")).toBeVisible()

  await window.getByTestId("fleet-agent-main").click()
  await expect(window.getByPlaceholder("Queue a message while the agent works…")).toBeVisible()

  const fleetToggle = window.getByRole("button", { name: /Fleet 2 active/ })
  await fleetToggle.click()
  await expect(fleetToggle).toHaveAttribute("aria-expanded", "false")
  await fleetToggle.click()
  await expect(fleetToggle).toHaveAttribute("aria-expanded", "true")
})
