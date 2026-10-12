import { appShell, expect, sessionRow, test } from "./fixtures.js"
import type { SeedSession } from "./fixtures.js"

/**
 * Boot behaviour: which screen the built app lands on, driven entirely by what's
 * in the throwaway `~/jingler`. No config → first-run setup. Seeded config +
 * sessions → the app shell with those sessions.
 */

test("first run (no config) shows the setup screen", async ({ launchApp }) => {
  const { window } = await launchApp()
  await expect(window.getByText("Set up your workspace")).toBeVisible()
  await expect(window.getByRole("button", { name: /choose repos folder/i })).toBeVisible()
})

test("a configured workspace boots into the app shell with its sessions", async ({ launchApp }) => {
  const seeded: SeedSession = {
    id: "s_seed_1",
    repo: "widget",
    branch: "chore/seed-session",
    title: "Seeded session",
    status: "idle",
    diff: { added: 0, removed: 0 },
    prNumber: null,
    costUsd: 0,
    tokens: 0,
    updatedAt: "2026-07-11T00:00:00.000Z"
  }
  const { window } = await launchApp({ configured: true, withRepo: true, sessions: [seeded] })

  // The sidebar (app shell) is present…
  await expect(appShell(window)).toBeVisible()
  // …and the persisted session shows up (grouped under its repo).
  await expect(sessionRow(window, "Seeded session")).toBeVisible()
  // Empty title-bar space drags the native window while its controls stay clickable.
  const titleBar = window.getByTestId("title-bar")
  await expect(titleBar).toHaveCSS("-webkit-app-region", "drag")
  await expect(titleBar.locator("#session-tab-bar-portal"))
    .toHaveCSS("-webkit-app-region", "none")
  // The setup screen is NOT shown.
  await expect(window.getByText("Set up your workspace")).toHaveCount(0)
})

test("crash screen renders when the app hits an unhandled error", async ({ launchApp }) => {
  const { window } = await launchApp({ configured: true, withRepo: true })

  try {
    // Set a flag in localStorage (persists through reload) that the App component checks.
    await window.evaluate(() => {
      localStorage.setItem('__TEST_CRASH', 'true')
    })

    // Reload to trigger the App component with the flag set.
    await window.reload()
    await window.waitForLoadState("domcontentloaded")

    // Assert the CrashScreen is visible with expected content.
    await expect(window.getByRole("alert")).toBeVisible()
    await expect(window.getByText("Jingler hit an error")).toBeVisible()
    await expect(window.getByText("Agents keep running in the background.")).toBeVisible()
    
    // The Reload button is visible.
    const reloadBtn = window.getByRole("button", { name: /reload window/i })
    await expect(reloadBtn).toBeVisible()

    // The Open logs button exists and is clickable.
    const openLogsBtn = window.getByRole("button", { name: /open logs/i })
    await expect(openLogsBtn).toBeVisible()
    await openLogsBtn.click()
    // The RPC call is fire-and-forget; verify the screen stays visible after the click.
    await expect(window.getByRole("alert")).toBeVisible()
  } finally {
    // Clean up the test flag, even if assertions fail.
    await window.evaluate(() => localStorage.removeItem('__TEST_CRASH'))
  }
})
