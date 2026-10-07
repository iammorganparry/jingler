import { cpSync } from "node:fs"
import { join } from "node:path"
import { addProject, appShell, expect, test } from "./fixtures.js"

test("one project picker owns workflow rows and routine drafts and revokes custom-control consent", async ({
  launchApp,
}) => {
  const { window, repoPath, reposDir } = await launchApp({
    configured: true,
    withRepo: true,
    piFixture: { scenarioId: "workspace-routines", authRoute: "api-key" },
  })
  const other = join(reposDir, "api")
  cpSync(repoPath, other, { recursive: true })
  await expect(appShell(window)).toBeVisible()
  await window.getByTestId("new-session").click()
  await addProject(window, repoPath)
  await addProject(window, other)
  await window.keyboard.press("Escape")
  await window.getByRole("button", { name: "Account menu" }).click()
  await window.getByRole("menuitem", { name: "Settings" }).click()
  await window.getByRole("button", { name: "Projects", exact: true }).click()
  await expect(window.getByRole("button", { name: "Routines", exact: true })).toHaveCount(0)
  const settings = window.getByTestId("project-workflow-settings")
  const picker = settings.getByRole("button", { name: "Local project", exact: true })
  await picker.click()
  await settings.getByRole("option", { name: "widget", exact: true }).click()
  await expect(settings.getByRole("button", { name: "Local project", exact: true })).toHaveCount(1)
  await window.setViewportSize({ width: 900, height: 700 })
  await settings.getByRole("button", { name: "Add run command" }).click()
  await settings.getByLabel("Run name 1", { exact: true }).fill("Dev")
  await settings.getByLabel("Run command 1", { exact: true }).fill("pnpm dev")
  const approval = settings.getByRole("checkbox", { name: /I approve these commands/ })
  await settings.getByRole("button", { name: "Save workflow" }).click()
  await expect(settings.getByRole("status")).toHaveText("Saved without approval. Commands will not run.")
  await expect(approval).toHaveAttribute("aria-checked", "false")
  await approval.click()
  await settings.getByRole("button", { name: "Add service port" }).click()
  await expect(approval).toHaveAttribute("aria-checked", "false")
  await settings.getByLabel("Service name 1", { exact: true }).fill("API")
  await settings.getByLabel("Service port 1", { exact: true }).fill("46000")
  await approval.click()
  await settings.getByRole("button", { name: "Save workflow" }).click()
  await expect(settings.getByText("Saved and approved for this exact content.")).toBeVisible()
  const routines = settings.getByRole("region", { name: "Saved desktop routines" })
  await routines.getByLabel("Name", { exact: true }).fill("Widget draft")
  await routines.getByLabel("Prompt", { exact: true }).fill("READONLY inspect README.md")
  const routineApproval = routines.getByRole("checkbox", { name: /I approve these exact settings/ })
  await routines.getByRole("button", { name: "Save routine" }).click()
  await expect(routines.getByRole("alert")).toContainText("Approve")
  await routineApproval.click()
  await routines.getByRole("button", { name: "Schedule", exact: true }).click()
  await routines.getByRole("option", { name: "Fixed interval", exact: true }).click()
  await expect(routineApproval).toHaveAttribute("aria-checked", "false")
  await expect(routines.getByLabel("Interval minutes")).toBeVisible()
  await routineApproval.click()
  await routines.getByRole("switch", { name: "Enable schedule" }).click()
  await expect(routineApproval).toHaveAttribute("aria-checked", "false")
  await picker.click()
  await settings.getByRole("option", { name: "api", exact: true }).click()
  await expect(settings.getByLabel("Run name 1", { exact: true })).toHaveCount(0)
  await expect(settings.getByText("Saved and approved for this exact content.")).toHaveCount(0)
  await expect(approval).toHaveAttribute("aria-checked", "false")
  await expect(routines.getByLabel("Name", { exact: true })).toHaveValue("")
  await expect(routines.getByLabel("Interval minutes")).toHaveCount(0)
  await expect(routineApproval).toHaveAttribute("aria-checked", "false")
  await expect(routines.getByRole("heading", { name: "All-project run history" })).toBeVisible()
  await picker.click()
  await settings.getByRole("option", { name: "widget", exact: true }).click()
  await expect(settings.getByLabel("Run name 1", { exact: true })).toHaveValue("Dev")
  await expect(settings.getByLabel("Service name 1", { exact: true })).toHaveValue("API")
  await expect(settings.getByLabel("Service port 1", { exact: true })).toHaveValue("46000")
  for (const width of [1500, 900]) {
    await window.setViewportSize({ width, height: 800 })
    await expect.poll(() => settings.evaluate((element) => {
      const bounds = element.getBoundingClientRect()
      const fields = Array.from(element.querySelectorAll("input, textarea, button"))
        .filter((field) => field.getBoundingClientRect().width > 0)
      const rectangles = fields.map((field) => field.getBoundingClientRect())
      const overlap = rectangles.some((left, index) => rectangles.slice(index + 1).some((right) =>
        left.left < right.right - 1 && right.left < left.right - 1 && left.top < right.bottom - 1 && right.top < left.bottom - 1))
      const scroll = element.closest('[data-testid="project-settings-scroll"]')
      return {
        contained: rectangles.every((rect) => rect.left >= bounds.left - 1 && rect.right <= bounds.right + 1),
        usable: Array.from(element.querySelectorAll("input, textarea")).every((field) => field.getBoundingClientRect().width >= 120),
        overlap,
        overflow: scroll ? scroll.scrollWidth - scroll.clientWidth : -1,
      }
    })).toEqual({ contained: true, usable: true, overlap: false, overflow: 0 })
  }

})

