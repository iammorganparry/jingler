/** Needs-you question card (#598, #457): focus on option 1, answer by number key, Switch session to Auto. */
import { appShell, expect, test, type SeedSession } from "./fixtures.js"

const seededSessions = ({ repoPath }: { repoPath: string }): ReadonlyArray<SeedSession> => [
  {
    id: "s_needs_you",
    repo: "widget",
    branch: "feat/needs-you",
    title: "Needs-you question card",
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

const askQuestion = async (window: import("@playwright/test").Page) => {
  const composer = window.getByPlaceholder("Message the agent…")
  await composer.fill("[[ask]] migrate the store")
  await composer.press("Enter")
  await expect(window.getByText("Agent needs your input")).toBeVisible({ timeout: 15_000 })
}

test("question card focuses option 1 and answers by number key", async ({ launchApp }) => {
  const { window } = await launchApp({ configured: true, withRepo: true, sessions: seededSessions })
  await expect(appShell(window)).toBeVisible()
  await askQuestion(window)

  await expect(window.locator("[data-option]").first()).toBeFocused()

  // Q1 (single): "2" picks Sliding session, Enter advances; Q2 (multi): "1" toggles, Enter submits.
  await window.keyboard.press("2")
  await window.keyboard.press("Enter")
  await expect(window.getByText("Which surfaces should adopt the new store?")).toBeVisible()
  await window.keyboard.press("1")
  await window.keyboard.press("Enter")

  await expect(window.getByText(/Got it — starting with/)).toBeVisible({ timeout: 15_000 })
  await expect(window.getByText("Sliding session").last()).toBeVisible()
})

test("Switch session to Auto on the question card changes the session mode", async ({ launchApp }) => {
  const { window } = await launchApp({ configured: true, withRepo: true, sessions: seededSessions })
  await expect(appShell(window)).toBeVisible()
  await expect(window.getByRole("button", { name: "Accept Edits", exact: true })).toBeVisible()
  await askQuestion(window)

  await window.getByRole("button", { name: "Switch session to Auto" }).click()

  // Already in Auto: the link is hidden (the composer, and its mode chip, are replaced by the card).
  await expect(window.getByRole("button", { name: "Switch session to Auto" })).toHaveCount(0)

  // Answer both questions; the composer returns showing the Auto mode chip.
  await window.keyboard.press("1")
  await window.keyboard.press("Enter")
  await window.keyboard.press("1")
  await window.keyboard.press("Enter")
  await expect(window.getByRole("button", { name: "Auto", exact: true })).toBeVisible({ timeout: 15_000 })
})
