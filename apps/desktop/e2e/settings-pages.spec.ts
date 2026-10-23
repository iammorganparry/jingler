import { appShell, expect, sessionRow, test } from "./fixtures.js"
import type { SeedSession } from "./fixtures.js"

const session: SeedSession = {
  id: "s_settingspages",
  repo: "widget",
  branch: "chore/s_settingspages",
  title: "Settings pages demo",
  status: "idle",
  diff: { added: 0, removed: 0 },
  prNumber: null,
  costUsd: 0,
  tokens: 0,
  updatedAt: "2026-07-16T00:00:00.000Z"
}

test("Header views: pin from Settings shows in the header, unpin returns it to More views", async ({ launchApp }) => {
  const { window } = await launchApp({ configured: true, withRepo: true, sessions: [session] })
  await expect(appShell(window)).toBeVisible()
  await sessionRow(window, "Settings pages demo").click()
  // Plan only exists for sessions with a plan; Files is a stable built-in view.
  await expect(window.getByTestId("header-view-files")).toHaveCount(0)

  await window.getByRole("button", { name: "Account menu" }).click()
  await window.getByRole("menuitem", { name: "Settings" }).click()
  await window.getByRole("button", { name: "Header views" }).click()
  await window.getByRole("switch", { name: "Pin Files to header" }).click()
  await window.getByRole("button", { name: "Close settings" }).click()

  await expect(window.getByTestId("header-view-files")).toBeVisible()

  await window.getByRole("button", { name: "Account menu" }).click()
  await window.getByRole("menuitem", { name: "Settings" }).click()
  await window.getByRole("button", { name: "Header views" }).click()
  await window.getByRole("switch", { name: "Pin Files to header" }).click()
  await window.getByRole("button", { name: "Close settings" }).click()

  await expect(window.getByTestId("header-view-files")).toHaveCount(0)
  await window.getByTestId("view-overflow-trigger").click()
  await expect(window.getByTestId("open-files")).toBeVisible()
})

test("Settings → Usage renders the page", async ({ launchApp }) => {
  const { window } = await launchApp({
    configured: true,
    withRepo: true,
    piFixture: { scenarioId: "usage-popover", authRoute: "claude-setup-token" }
  })
  await expect(appShell(window)).toBeVisible()
  await window.getByRole("button", { name: "Account menu" }).click()
  await window.getByRole("menuitem", { name: "Settings" }).click()
  await window.getByRole("button", { name: "Usage", exact: true }).click()
  await expect(window.getByTestId("usage-page")).toBeVisible()
})
