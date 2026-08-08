import { appShell, expect, sessionRow, test } from "./fixtures.js"

const enabled = process.env.JINGLER_REAL_DEVICE_QA === "1"

test.skip(!enabled, "Physical Mac mini QA is opt-in")

const requiredEnvironment = (name: string): string => {
  const value = process.env[name]
  if (!value) throw new Error(`${name} is required for physical remote-device QA`)
  return value
}

test("pairs and runs on a physical remote environment", async ({ launchApp }) => {
  const host = requiredEnvironment("JINGLER_REAL_DEVICE_HOST")
  const username = requiredEnvironment("JINGLER_REAL_DEVICE_USER")
  const identityFile = requiredEnvironment("JINGLER_REAL_DEVICE_IDENTITY")
  const relayHost = requiredEnvironment("JINGLER_REAL_DEVICE_RELAY_HOST")
  const app = await launchApp({
    configured: true,
    withRepo: true,
    realRemoteEnvironment: { host, username, identityFile, relayHost }
  })
  const remoteName = new RegExp(`^${host}$`, "i")

  await expect(appShell(app.window)).toBeVisible()
  await app.window.getByRole("button", { name: "Account menu" }).click()
  await app.window.getByRole("menuitem", { name: "Settings" }).click()
  await app.window.getByRole("button", { name: /^Devices/ }).click()
  await app.window.getByRole("button", { name: "Add environment" }).click()
  await app.window.getByRole("button", { name: /^SSH\b/ }).click()
  await app.window.getByText(host, { exact: true }).click()
  await app.window.getByRole("button", { name: "Connect environment" }).click()
  await expect(app.window.getByRole("status")).toContainText(/mac is connected/i, {
    timeout: 30_000
  })
  await app.window.keyboard.press("Escape")
  await app.window.getByRole("button", { name: "Refresh" }).click()
  await expect(app.window.getByText("online", { exact: true })).toBeVisible({
    timeout: 30_000
  })
  await app.window.getByRole("button", { name: "Close settings" }).click()

  await app.window.getByTestId("new-session").click()
  await app.window.getByRole("combobox").first().click()
  await app.window.getByRole("option", { name: remoteName }).click()
  await app.window.getByPlaceholder("Leave blank for agent naming").fill("Physical Mac mini QA")
  await expect(app.window.getByRole("button", { name: "Create", exact: true })).toBeEnabled({
    timeout: 30_000
  })
  await app.window.getByRole("button", { name: "Create", exact: true }).click()
  await expect(sessionRow(app.window, "Physical Mac mini QA")).toBeVisible({
    timeout: 30_000
  })

  const composer = app.window.getByPlaceholder("Message Claude…")
  await composer.fill("Reply with exactly: physical remote session verified")
  await composer.press("Enter")
  await expect(
    app.window.getByText("physical remote session verified", { exact: false })
  ).toBeVisible({ timeout: 120_000 })

  const row = sessionRow(app.window, "Physical Mac mini QA")
  await expect(async () => {
    await row.click({ button: "right" })
    await app.window.getByRole("menuitem", { name: "Delete" }).click({ timeout: 2_000 })
  }).toPass({ timeout: 10_000 })
  await app.window.getByRole("dialog").getByRole("button", { name: "Delete" }).click()
  await expect(row).toHaveCount(0)

  await app.window.getByRole("button", { name: "Account menu" }).click()
  await app.window.getByRole("menuitem", { name: "Settings" }).click()
  await app.window.getByRole("button", { name: /^Devices/ }).click()
  app.window.once("dialog", (dialog) => dialog.accept())
  await app.window.getByRole("button", { name: "Revoke" }).click()
  await expect(app.window.getByText("No paired devices yet.")).toBeVisible()
})
