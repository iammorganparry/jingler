import { fileURLToPath } from "node:url"
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
const DIRECT_AGENT = /Inspect direct delegation/
const SUPERVISOR_REVIEW_TASK = "Review the checkout flow against its acceptance criteria."
const SUPERVISOR_CHILD_WRAPPER = fileURLToPath(
  new URL("./pi-supervisor-child.mjs", import.meta.url)
)
const REVIEWER_REPLY_PLACEHOLDER = /Reply to reviewer/i

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
  await expect(
    window.getByTestId("composer").getByTestId("fleet-drawer")
  ).toBeVisible()
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

test("one direct child remains inspectable while the operator steers Main", async ({
  launchApp
}) => {
  const { window } = await launchApp({ configured: true, withRepo: true, sessions: seededSessions })
  await expect(appShell(window)).toBeVisible()

  const composer = window.getByPlaceholder("Message the agent…")
  await composer.fill("[[direct-subagent]] inspect delegation")
  await composer.press("Enter")

  const fleet = window.getByTestId("fleet-drawer")
  const direct = fleet.getByRole("button", { name: DIRECT_AGENT })
  await expect(direct).toBeVisible({ timeout: 15_000 })
  await expect(fleet.locator('[data-testid^="fleet-workflow-"]')).toHaveCount(0)
  await expect(fleet).toContainText("1 active · 1 total")
  await expect(window.getByText("Delegated to one direct child.")).toBeVisible()

  await direct.click()
  await expect(window.getByTestId("fleet-agent-live")).toContainText(
    "This agent is running. Its full transcript appears here once it records output."
  )
  await window.getByTestId("fleet-agent-main").click()

  const busyComposer = window.getByPlaceholder("Queue a message while the agent works…")
  await busyComposer.fill("keep the direct child visible")
  await busyComposer.press("Enter")
  await expect(window.getByText("Noted: keep the direct child visible")).toBeVisible({
    timeout: 15_000
  })
  await expect(fleet.locator('[data-testid^="fleet-workflow-"]')).toHaveCount(0)
  await expect(direct).toBeVisible()

  await expect(window.getByText("Direct child reported back.")).toBeVisible({ timeout: 15_000 })
  await expect(fleet).toContainText("0 active · 1 total")
  await expect(fleet.locator('[data-testid^="fleet-workflow-"]')).toHaveCount(0)
})

test("a reviewer exposes its prompt and detaches from Main without the watcher delay", async ({
  launchApp
}) => {
  const { window } = await launchApp({
    configured: true,
    withRepo: true,
    sessions: seededSessions,
    e2eEnv: { JINGLER_SUBAGENT_WRAPPER_PATH: SUPERVISOR_CHILD_WRAPPER }
  })
  await expect(appShell(window)).toBeVisible()

  const composer = window.getByPlaceholder("Message the agent…")
  await composer.fill("[[supervisor-subagent]] review checkout")
  await composer.press("Enter")

  // The fixture does not create the filesystem supervisor request for eight
  // seconds. Main becoming idle inside five seconds proves the child detached
  // from the blocking tool-start event rather than the watcher fallback.
  await expect(window.getByText(
    "Reviewer detached promptly and is waiting for supervisor input."
  )).toBeVisible({ timeout: 5_000 })
  await expect(window.getByPlaceholder("Message the agent…")).toBeVisible()

  const fleet = window.getByTestId("fleet-drawer")
  const reviewer = fleet.getByRole("button", { name: new RegExp(SUPERVISOR_REVIEW_TASK) })
  await expect(reviewer).toBeVisible()
  await reviewer.click()
  const transcript = window.getByTestId("fleet-agent-transcript")
  await expect(transcript).toContainText(SUPERVISOR_REVIEW_TASK)
  await expect(transcript).not.toContainText("[prompt redacted]")
  await expect(transcript).toContainText("## Acceptance Contract")

  await expect(fleet).toContainText(
    "Should I include accessibility behavior in this review?",
    { timeout: 20_000 }
  )
  const reply = window.getByPlaceholder(REVIEWER_REPLY_PLACEHOLDER)
  await expect(reply).toBeVisible()
  await reply.fill("Include accessibility behavior.")
  await reply.press("Enter")

  await expect(fleet).toContainText(
    "reply request delivered by pi-subagents",
    { timeout: 5_000 }
  )
  await expect(fleet).not.toContainText("rejected")
})

test("global Stop reaps every held Fleet child and restores the idle composer", async ({
  launchApp
}) => {
  const { window } = await launchApp({ configured: true, withRepo: true, sessions: seededSessions })
  await expect(appShell(window)).toBeVisible()

  const composer = window.getByPlaceholder("Message the agent…")
  await composer.fill("[[held-subagents]] stop the fleet")
  await composer.press("Enter")

  const fleet = window.getByTestId("fleet-drawer")
  await expect(fleet.locator('[data-agent-status="running"]')).toHaveCount(2, {
    timeout: 15_000
  })
  await window.getByRole("button", { name: "Stop", exact: true }).click()

  await expect(fleet.locator('[data-agent-status="stopped"]')).toHaveCount(2, {
    timeout: 15_000
  })
  await expect(fleet).toContainText("0 active · 2 total")
  await expect(window.getByPlaceholder("Message the agent…")).toBeVisible()
  await expect(window.getByRole("button", { name: "Stop", exact: true })).toBeHidden()
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
  // A running child with no readable transcript now shows its live activity —
  // agent, task, and running totals — rather than a blank "not available yet".
  await expect(window.getByTestId("fleet-agent-live")).toBeVisible()
  await expect(window.getByTestId("fleet-drawer")).toBeVisible()

  await window.getByTestId("fleet-agent-main").click()
  await expect(window.getByPlaceholder("Queue a message while the agent works…")).toBeVisible()

  // The Plan/Fleet drawer collapses from the tab strip's chevron (label flips
  // between "Collapse drawer" and "Expand drawer", so match either).
  const drawerToggle = window.getByRole("button", { name: /drawer/i })
  await drawerToggle.click()
  await expect(drawerToggle).toHaveAttribute("aria-expanded", "false")
  await drawerToggle.click()
  await expect(drawerToggle).toHaveAttribute("aria-expanded", "true")
})
