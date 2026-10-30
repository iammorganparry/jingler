/** Home needs-you card (#476): a pending question surfaces on Home once the pane is closed; Answer returns to the session. */
import { appShell, expect, test, type SeedSession } from "./fixtures.js"

const seededSessions = ({ repoPath }: { repoPath: string }): ReadonlyArray<SeedSession> => [
  {
    id: "s_home_needs_you",
    repo: "widget",
    branch: "feat/home",
    title: "Home needs-you",
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

test("Home shows a needs-you card for a pending question and Answer reopens the session", async ({ launchApp }) => {
  const { window } = await launchApp({ configured: true, withRepo: true, sessions: seededSessions })
  await expect(appShell(window)).toBeVisible()
  const composer = window.getByPlaceholder("Message the agent…")
  await composer.fill("[[ask]] migrate the store")
  await composer.press("Enter")
  await expect(window.getByText("Agent needs your input")).toBeVisible({ timeout: 15_000 })

  // Home leaves the blocked workspace's chat open, so its card stays live.
  await window.getByTestId("home-sidebar-item").click()
  const cards = window.getByTestId("home-cards")
  await expect(cards.getByText("Home needs-you", { exact: true })).toBeVisible()
  await expect(cards.getByText("Needs input", { exact: true })).toBeVisible()

  await cards.getByRole("button", { name: "Answer", exact: true }).click()
  await expect(window.getByText("Agent needs your input")).toBeVisible()
})

test("Allow on a Home card resolves a pending approval gate", async ({ launchApp }) => {
  const { window } = await launchApp({ configured: true, withRepo: true, sessions: seededSessions })
  await expect(appShell(window)).toBeVisible()
  const composer = window.getByPlaceholder("Message the agent…")
  await composer.fill("Add rate limiting to the settings endpoint.")
  await composer.press("Enter")
  await expect(window.getByText("Approval needed · run a command")).toBeVisible({ timeout: 20_000 })

  // Home leaves the blocked workspace's chat open, so its card stays live.
  await window.getByTestId("home-sidebar-item").click()
  const cards = window.getByTestId("home-cards")
  await cards.getByRole("button", { name: "Allow", exact: true }).click()
  await expect(cards.getByRole("button", { name: "Allow", exact: true })).toHaveCount(0)
})
