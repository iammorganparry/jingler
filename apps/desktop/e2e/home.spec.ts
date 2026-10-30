/** Composer-first Home (#476 slice 3): greeting, composer, starters; the prompt, project and source reach New workspace. */
import { addProject, appShell, expect, test } from "./fixtures.js"

test("Home composer hands prompt + project to New workspace; starters preselect the source", async ({ launchApp }) => {
  const { window, repoPath } = await launchApp({ configured: true, withRepo: true })
  await expect(appShell(window)).toBeVisible()

  // Register the repo as a project, then return to Home (no sessions).
  await window.getByTestId("new-session").click()
  await addProject(window, repoPath)
  await window.getByRole("button", { name: "Close new session", exact: true }).click()

  await expect(window.getByRole("heading", { name: /^Good (morning|afternoon|evening)/ })).toBeVisible()
  const composer = window.getByRole("textbox", { name: "What should we build?" })
  await expect(composer).toBeVisible()
  for (const label of ["Start from a GitHub issue", "Start from a PR", "Describe a task"]) {
    await expect(window.getByTestId("home-starters").getByRole("button", { name: label })).toBeVisible()
  }
  await expect(window.getByRole("button", { name: "Project", exact: true })).toContainText("widget")

  // Home uses the shared Composer (QA Q19).
  await expect(window.getByTestId("composer")).toBeVisible()
  await expect(window.getByRole("button", { name: "Send ↵" })).toBeVisible()

  await composer.fill("fix the flaky login test")
  await composer.press("Meta+Enter")
  const view = window.getByTestId("new-session-view")
  await expect(view).toBeVisible()
  await expect(view.getByRole("button", { name: "Project", exact: true })).toContainText("widget")
  await expect(view.getByRole("textbox").first()).toHaveValue("fix the flaky login test")

  // Starter row: New workspace opens with the Pull request source selected.
  await window.getByRole("button", { name: "Close new session", exact: true }).click()
  await window.getByTestId("home-starters").getByRole("button", { name: "Start from a PR" }).click()
  await expect(view).toBeVisible()
  await view.getByRole("button", { name: "Start from", exact: true }).click()
  await expect(window.getByRole("tab", { name: "Pull request", selected: true })).toBeVisible()
})
