/** Home is New session: the New session composer (project/Auto, source, model) lives on Home, and every New session entry point lands there. */
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { addProject, appShell, expect, test } from "./fixtures.js"

test("Home hosts the New session composer; starters preselect the source; ⌘N from a session returns Home", async ({ launchApp }) => {
  const { window, repoPath } = await launchApp({ configured: true, withRepo: true })
  await expect(appShell(window)).toBeVisible()

  await expect(window.getByRole("heading", { name: /^Good (morning|afternoon|evening)/ })).toBeVisible()
  const view = window.getByTestId("new-session-view")
  await expect(view).toBeVisible()
  await addProject(window, repoPath)
  const project = view.getByRole("button", { name: "Project", exact: true })
  await expect(project).toContainText("widget")
  // Auto repo is offered right on Home.
  await project.click()
  await expect(window.getByRole("option", { name: /^Auto/ })).toBeVisible()
  await window.keyboard.press("Escape")

  const composer = window.getByRole("textbox", { name: "What should we build?" })
  await expect(composer).toBeVisible()
  for (const label of ["Start from a GitHub issue", "Start from a PR", "Describe a task"]) {
    await expect(window.getByTestId("home-starters").getByRole("button", { name: label })).toBeVisible()
  }

  await window.getByTestId("home-starters").getByRole("button", { name: "Start from a PR" }).click()
  await view.getByRole("button", { name: "Start from", exact: true }).click()
  await expect(window.getByRole("tab", { name: "Pull request", selected: true })).toBeVisible()
  await window.keyboard.press("Escape")

  // The sidebar's New session button stays on Home and focuses the composer.
  await window.getByTestId("new-session").click()
  await expect(composer).toBeFocused()
})

test("a prompt sent from Home creates the session; ⌘N from that session returns Home focused", async ({ launchApp }) => {
  const { window, repoPath, home } = await launchApp({ configured: true, withRepo: true })
  await expect(appShell(window)).toBeVisible()
  await addProject(window, repoPath)
  const composer = window.getByRole("textbox", { name: "What should we build?" })
  await composer.fill("Fix keyboard tab closing")
  await composer.press("Enter")

  const row = window.locator("[data-testid^='session-row-']").first()
  await expect(row).toBeVisible({ timeout: 20_000 })
  await expect(window.getByTestId("new-session-view")).toHaveCount(0)
  await expect.poll(() => JSON.parse(readFileSync(join(home, "jingler", "sessions.json"), "utf8"))[0]?.title, { timeout: 20_000 })
    .toBe("Fix keyboard tab closing")

  await window.keyboard.press("Meta+n")
  await expect(window.getByRole("heading", { name: /^Good (morning|afternoon|evening)/ })).toBeVisible()
  await expect(composer).toBeFocused()
  await expect(composer).toHaveValue("")
})
