import { appShell, expect, test } from "./fixtures.js"

test.skip(process.platform !== "darwin", "the blocked row opens a macOS-only pane")

test("blocked notification permission shows the warning and opens System Settings", async ({
  launchApp
}) => {
  const { window, app } = await launchApp({
    configured: true,
    withRepo: true,
    e2eEnv: { JINGLER_E2E_NOTIFICATION_PERMISSION: "denied" }
  })
  // Capture the hand-off instead of really opening System Settings.
  await app.evaluate(({ shell }) => {
    const opened: string[] = []
    ;(globalThis as { __opened?: string[] }).__opened = opened
    shell.openExternal = async (url: string) => {
      opened.push(url)
    }
  })

  await expect(appShell(window)).toBeVisible()
  await window.getByRole("button", { name: "Account menu" }).click()
  await window.getByRole("menuitem", { name: "Settings" }).click()
  await window.getByRole("button", { name: "Notifications" }).click()

  await expect(window.getByText("Notifications are blocked by macOS")).toBeVisible()
  await window.getByRole("button", { name: "Open System Settings" }).click()

  await expect
    .poll(() => app.evaluate(() => (globalThis as { __opened?: string[] }).__opened))
    .toEqual(["x-apple.systempreferences:com.apple.Notifications-Settings.extension"])
})
