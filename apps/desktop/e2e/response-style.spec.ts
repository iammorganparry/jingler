import { readFileSync } from "node:fs"
import { join } from "node:path"
import { appShell, expect, test } from "./fixtures.js"

test("response style defaults to concise and persists a new choice", async ({ launchApp }) => {
  const app = await launchApp({ configured: true, withRepo: true })
  const { window, home } = app

  await expect(appShell(window)).toBeVisible()
  await window.getByRole("button", { name: "Account menu" }).click()
  await window.getByRole("menuitem", { name: "Settings" }).click()
  await window.getByRole("button", { name: "General" }).click()

  const control = window.getByRole("tablist", { name: "Response style" })
  await expect(control.getByRole("tab", { name: "Concise" })).toHaveAttribute("aria-selected", "true")
  await control.getByRole("tab", { name: "ADHD" }).click()
  await expect(control.getByRole("tab", { name: "ADHD" })).toHaveAttribute("aria-selected", "true")

  await expect
    .poll(() => {
      try {
        const raw = readFileSync(join(home, "jingler", "config.json"), "utf8")
        // SAFETY: ConfigService writes this file through the WorkspaceConfig schema;
        // only the optional responseStyle field is read.
        return (JSON.parse(raw) as { responseStyle?: string }).responseStyle
      } catch {
        return null
      }
    })
    .toBe("adhd")
})
