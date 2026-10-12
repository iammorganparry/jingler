import { appShell, expect, test } from "./fixtures.js"

test("window controls render only on non-darwin and can maximize", async ({ launchApp }) => {
  const { app, window } = await launchApp({ configured: true })

  await expect(appShell(window)).toBeVisible()

  const platform = process.platform

  if (platform === "darwin") {
    // macOS: no custom controls, native traffic lights instead
    await expect(window.getByTestId("window-controls")).not.toBeVisible()
  } else {
    // Windows/Linux: custom controls visible
    await expect(window.getByTestId("window-controls")).toBeVisible()

    // Click maximize button
    const maximizeButton = window.getByRole("button", { name: "Maximize" })
    await expect(maximizeButton).toBeVisible()
    await maximizeButton.click()

    // Verify window is maximized
    const isMaximized = await app.evaluate(({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows()[0]
      return win?.isMaximized() ?? false
    })
    expect(isMaximized).toBe(true)

    // Button should now say "Restore"
    await expect(window.getByRole("button", { name: "Restore" })).toBeVisible()

    // Click restore (toggle maximize again)
    await window.getByRole("button", { name: "Restore" }).click()

    // Verify window is restored
    const isRestored = await app.evaluate(({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows()[0]
      return !(win?.isMaximized() ?? true)
    })
    expect(isRestored).toBe(true)
  }
})
