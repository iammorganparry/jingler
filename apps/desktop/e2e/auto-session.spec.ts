import { readFileSync } from "node:fs"
import { join } from "node:path"
import type { Page } from "@playwright/test"
import { appShell, expect, test } from "./fixtures.js"

interface PersistedCheckout {
  readonly id: string
  readonly repo: string
  readonly repoPath?: string
  readonly worktreePath?: string
}
interface PersistedSession {
  readonly repo: string
  readonly repoPath?: string
  readonly checkouts?: ReadonlyArray<PersistedCheckout>
}

const sessionsAt = (home: string): ReadonlyArray<PersistedSession> =>
  JSON.parse(readFileSync(join(home, "jingler", "sessions.json"), "utf8")) as ReadonlyArray<PersistedSession>

/** Approve every gate the turn raises (the write is gated in ask mode). */
const allowGates = async (window: Page, until: () => Promise<boolean>): Promise<void> => {
  await expect
    .poll(async () => {
      const allow = window.getByRole("button", { name: /Allow once/ }).first()
      if (await allow.isVisible().catch(() => false)) await allow.click().catch(() => undefined)
      return until()
    }, { timeout: 40_000 })
    .toBe(true)
}

test("Auto: a session created with no repo shows \"No repo\" until the agent attaches one", async ({ launchApp }) => {
  const { window, home, repoPath } = await launchApp({ configured: true, withRepo: true })
  await expect(appShell(window)).toBeVisible()

  // Seed a project so the Project picker has one — Auto must be chosen
  // explicitly, never a fallback, so this just proves it isn't.
  await window.getByTestId("new-session").click()
  await expect(window.getByRole("heading", { name: "New session" })).toBeVisible()
  if ((await window.getByTestId("new-session-view").getByText("Add a project before starting a session.").count()) > 0) {
    await window.getByTestId("new-session-view").getByRole("button", { name: "Add project" }).click()
    await window.getByRole("option", { name: /^Local repository/ }).click()
    const directorySearch = window.getByPlaceholder("Search folders or enter an absolute path…")
    await directorySearch.fill(repoPath)
    await directorySearch.press("Enter")
    await expect(window.getByText(repoPath, { exact: true })).toBeVisible()
    await window.getByRole("button", { name: "Choose current folder" }).click()
    await window.getByRole("dialog").getByRole("button", { name: "Add project" }).click()
  }

  await window.getByRole("button", { name: "Project", exact: true }).click()
  await window.getByRole("option", { name: "Auto" }).click()
  await window.getByPlaceholder("Message the agent…").fill("[[switch-repo=" + repoPath + "]] work in the repo")
  await window.getByPlaceholder("Message the agent…").press("Enter")
  await expect(window.locator("[data-testid^='session-row-']")).toHaveCount(1, { timeout: 20_000 })

  // Before the agent attaches a repo: "No repo" everywhere repo/branch would show.
  const row = window.locator("[data-testid^='session-row-']").first()
  await expect(row).toContainText("No repo")

  // The agent switches into the fixture repo and edits a file there.
  await expect(window.getByText("Switched to", { exact: false }).first()).toBeVisible({ timeout: 40_000 })
  await expect(window.getByText("Edited the second repository.")).toBeVisible({ timeout: 40_000 })
  await allowGates(window, async () => (sessionsAt(home)[0]?.checkouts?.length ?? 0) > 0)

  // Once attached, the normal single-checkout header applies: no switcher
  // (only one checkout), and the sidebar row now names the real repo.
  await expect(row).not.toContainText("No repo")
  const session = sessionsAt(home)[0]!
  expect(session.checkouts).toHaveLength(1)
  expect(session.checkouts![0]!.repoPath).toBe(repoPath)

  // Changes lists the edited file for the attached repo.
  await window.getByRole("button", { name: /^Changes\b/ }).first().click()
  await expect(window.getByText("No repo")).toHaveCount(0)
  await expect(window.locator('[data-item-path="src/other-repo.ts"]')).toBeVisible({ timeout: 20_000 })
})
