import { readFileSync } from "node:fs"
import { join } from "node:path"
import { appShell, expect, test } from "./fixtures.js"

const GENERAL = /^General/

test("AI telemetry is off by default and the Privacy toggle persists an opt-in", async ({ launchApp }) => {
  const app = await launchApp({ configured: true })
  await expect(appShell(app.window)).toBeVisible()

  await app.window.getByRole("button", { name: "Account menu" }).click()
  await app.window.getByRole("menuitem", { name: "Settings" }).click()
  await app.window.getByRole("button", { name: GENERAL }).click()
  const toggle = app.window.getByRole("switch", { name: "Share AI telemetry" })
  await expect(toggle).not.toBeChecked()

  await toggle.click()
  await expect(toggle).toBeChecked()
  const configFile = join(app.home, "jingler", "config.json")
  await expect.poll(() => JSON.parse(readFileSync(configFile, "utf8")).telemetryEnabled).toBe(true)

  await app.window.reload()
  await expect(appShell(app.window)).toBeVisible()
  await app.window.getByRole("button", { name: "Account menu" }).click()
  await app.window.getByRole("menuitem", { name: "Settings" }).click()
  await app.window.getByRole("button", { name: GENERAL }).click()
  await expect(app.window.getByRole("switch", { name: "Share AI telemetry" })).toBeChecked()
})
