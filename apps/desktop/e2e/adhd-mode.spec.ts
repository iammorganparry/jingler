import { readFileSync } from "node:fs"
import { join } from "node:path"
import { appShell, expect, test } from "./fixtures.js"

const DESCRIPTION =
  "Only final completion summaries lead with the action, number multi-step work, state progress, and end with one next step. Working updates, planning, and questions stay natural."

test("ADHD mode scopes response shaping to completion summaries and persists", async ({
  launchApp
}) => {
  const app = await launchApp({ configured: true, withRepo: true })
  const { window, home } = app

  await expect(appShell(window)).toBeVisible()
  await window.getByRole("button", { name: "Account menu" }).click()
  await window.getByRole("menuitem", { name: "Settings" }).click()
  await window.getByRole("button", { name: "General" }).click()

  const description = window.getByText(DESCRIPTION, { exact: true })
  await expect(description).toBeVisible()
  const toggle = description.locator("..").locator("..").getByRole("switch")
  await expect(toggle).not.toBeChecked()
  await toggle.click()
  await expect(toggle).toBeChecked()

  await expect
    .poll(() => {
      try {
        const raw = readFileSync(join(home, "jingler", "config.json"), "utf8")
        return (JSON.parse(raw) as { adhdMode?: boolean }).adhdMode
      } catch {
        return null
      }
    })
    .toBe(true)
})
