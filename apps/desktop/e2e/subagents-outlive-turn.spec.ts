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
const SUPERVISOR_CHILD_WORKER = fileURLToPath(
  new URL("./pi-supervisor-child.mjs", import.meta.url)
)
const REVIEWER_REPLY_PLACEHOLDER = /Reply to reviewer/i

const openPreviousChats = async (window: Parameters<typeof appShell>[0]) => {
  await window.getByRole("button", { name: "Previous chats" }).click()
}

test("live subagents get chat-row tabs and completed output moves to Previous chats", async ({
  launchApp
}) => {
  const { window } = await launchApp({ configured: true, withRepo: true, sessions: seededSessions })
  await expect(appShell(window)).toBeVisible()

  const composer = window.getByPlaceholder("Message the agent…")
  await composer.fill("[[held-subagents]] map the UI")
  await composer.press("Enter")

  const first = window.getByRole("button", { name: FIRST_AGENT })
  const second = window.getByRole("button", { name: SECOND_AGENT })
  await expect(first).toBeVisible({ timeout: 15_000 })
  await expect(second).toBeVisible()
  await expect(window.getByText("Delegated to two agents.")).toBeVisible()

  const busyComposer = window.getByPlaceholder("Queue a message while the agent works…")
  await busyComposer.fill("also check the theme tokens")
  await busyComposer.press("Enter")
  await expect(window.getByText("Noted: also check the theme tokens")).toBeVisible({
    timeout: 15_000
  })

  await expect(window.getByText("Both agents reported back.")).toBeVisible({ timeout: 15_000 })
  await expect(first).toHaveCount(0)
  await expect(second).toHaveCount(0)
  await openPreviousChats(window)
  await expect(window.getByRole("menuitem", { name: /Open .*Survey the tab bar/ })).toBeVisible()
  await expect(window.getByRole("menuitem", { name: /Open .*Audit the theme tokens/ })).toBeVisible()
})

test("a new chat never renders the previous chat's live subagents", async ({
  launchApp
}) => {
  const { window } = await launchApp({ configured: true, withRepo: true, sessions: seededSessions })
  const composer = window.getByPlaceholder("Message the agent…")
  await composer.fill("[[held-subagents]] map the UI")
  await composer.press("Enter")
  const first = window.getByRole("button", { name: FIRST_AGENT })
  const second = window.getByRole("button", { name: SECOND_AGENT })
  await expect(first).toBeVisible({ timeout: 15_000 })
  await expect(second).toBeVisible()

  await window.getByRole("button", { name: "New tab" }).click()
  await window.getByTestId("new-tab-option-chat").click()
  await expect(window.getByTitle("2. Chat 2")).toHaveAttribute("aria-current", "page")
  await Promise.all([250, 500, 1_000, 2_000, 4_000].map(async (delay) => {
    await window.waitForTimeout(delay)
    expect(await first.count()).toBe(0)
    expect(await second.count()).toBe(0)
  }))
})

test("selecting a direct child opens its transcript and the parent chat restores Main", async ({
  launchApp
}) => {
  const { window } = await launchApp({ configured: true, withRepo: true, sessions: seededSessions })
  await expect(appShell(window)).toBeVisible()
  const mainTab = window.locator('[data-testid^="chat-tab-"]').first().getByRole("button").first()

  const composer = window.getByPlaceholder("Message the agent…")
  await composer.fill("[[direct-subagent]] inspect delegation")
  await composer.press("Enter")

  const direct = window.getByRole("button", { name: DIRECT_AGENT })
  await expect(direct).toBeVisible({ timeout: 15_000 })
  await direct.click()
  await expect(window.getByTestId("fleet-agent-transcript")).toBeVisible()
  await expect(window.getByTestId("fleet-agent-live")).toContainText(
    "This agent is running. Its full transcript appears here once it records output."
  )

  await mainTab.click()
  const busyComposer = window.getByPlaceholder("Queue a message while the agent works…")
  await expect(busyComposer).toBeVisible()
  await busyComposer.fill("keep the direct child visible")
  await busyComposer.press("Enter")
  await expect(window.getByText("Noted: keep the direct child visible")).toBeVisible({
    timeout: 15_000
  })
  await expect(window.getByText("Direct child reported back.")).toBeVisible({ timeout: 15_000 })
  await expect(direct).toHaveCount(0)
  await openPreviousChats(window)
  await expect(window.getByRole("menuitem", { name: /Open .*Inspect direct delegation/ })).toBeVisible()
})

test("a reviewer tab exposes its prompt and supervisor request", async ({
  launchApp
}) => {
  const { window } = await launchApp({
    configured: true,
    withRepo: true,
    sessions: seededSessions,
    e2eEnv: { JINGLER_SUBAGENT_PROCESS_WORKER: SUPERVISOR_CHILD_WORKER }
  })
  await expect(appShell(window)).toBeVisible()

  const composer = window.getByPlaceholder("Message the agent…")
  await composer.fill("[[supervisor-subagent]] review checkout")
  await composer.press("Enter")
  await expect(window.getByText(
    "Reviewer detached promptly and is waiting for supervisor input."
  )).toBeVisible({ timeout: 5_000 })

  const reviewer = window.getByRole("button", { name: new RegExp(SUPERVISOR_REVIEW_TASK) })
  await expect(reviewer).toBeVisible()
  await reviewer.click()
  const transcript = window.getByTestId("fleet-agent-transcript")
  await expect(transcript).toContainText(SUPERVISOR_REVIEW_TASK)
  await expect(transcript).not.toContainText("[prompt redacted]")
  await expect(transcript).toContainText("## Acceptance Contract")
  await expect(transcript).toContainText(
    "Should I include accessibility behavior in this review?",
    { timeout: 20_000 }
  )

  const reply = window.getByPlaceholder(REVIEWER_REPLY_PLACEHOLDER)
  await reply.fill("Include accessibility behavior.")
  await reply.press("Enter")
  await expect(window.getByTestId("subagent-control-outcome")).toContainText(
    "reply request delivered by pi-subagents"
  )
})

test("global Stop removes every held subagent tab and restores the idle composer", async ({
  launchApp
}) => {
  const { window } = await launchApp({ configured: true, withRepo: true, sessions: seededSessions })
  await expect(appShell(window)).toBeVisible()

  const composer = window.getByPlaceholder("Message the agent…")
  await composer.fill("[[held-subagents]] stop the agents")
  await composer.press("Enter")
  const first = window.getByRole("button", { name: FIRST_AGENT })
  const second = window.getByRole("button", { name: SECOND_AGENT })
  await expect(first).toBeVisible({ timeout: 15_000 })
  await expect(second).toBeVisible()

  await window.getByRole("button", { name: "Stop", exact: true }).click()

  await expect(first).toHaveCount(0, { timeout: 15_000 })
  await expect(second).toHaveCount(0)
  await expect(window.getByPlaceholder("Message the agent…")).toBeVisible()
  await expect(window.getByRole("button", { name: "Stop", exact: true })).toBeHidden()
})

test("completed compatibility-agent output remains in Previous chats", async ({
  launchApp
}) => {
  const { window } = await launchApp({ configured: true, withRepo: true, sessions: seededSessions })
  await expect(appShell(window)).toBeVisible()

  await window.getByPlaceholder("Message the agent…").fill("[[legacy-agent]] inspect compatibility")
  await window.getByPlaceholder("Message the agent…").press("Enter")
  await expect(window.getByRole("button", { name: "Previous chats" })).toBeVisible({
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
