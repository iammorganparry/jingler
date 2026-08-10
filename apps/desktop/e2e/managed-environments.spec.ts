import { appShell, expect, test, type SeedSession } from "./fixtures.js"

const localSession = (repoPath: string): SeedSession => ({
  id: "session_managed_environment_e2e",
  repo: "widget",
  branch: "main",
  title: "Managed environment picker",
  status: "idle",
  cli: "claude",
  diff: { added: 0, removed: 0 },
  prNumber: null,
  costUsd: 0,
  tokens: 0,
  updatedAt: "2026-08-10T00:00:00.000Z",
  worktreePath: repoPath,
  repoPath,
  baseBranch: "main",
  mode: "auto"
})

test("creates, selects, and deletes an authenticated cloud environment", async ({
  launchApp
}) => {
  const app = await launchApp({
    configured: true,
    withRepo: true,
    sessions: ({ repoPath }) => [localSession(repoPath)]
  })
  await expect(appShell(app.window)).toBeVisible()

  await app.window.getByRole("button", { name: "Account menu" }).click()
  await app.window.getByRole("menuitem", { name: "Settings" }).click()
  await app.window.getByRole("button", { name: /^Devices/ }).click()

  await app.window.getByRole("button", { name: "Add cloud environment" }).click()
  await app.window.getByLabel("Cloud environment name").fill("E2E cloud")
  await app.window.getByRole("button", { name: "Create", exact: true }).click()

  const environment = app.window.getByText("E2E cloud", { exact: true })
  await expect(environment).toBeVisible()
  await expect(environment.locator("..").locator("..")).toContainText("basic")
  await expect(environment.locator("..").locator("..")).toContainText("online")

  await app.window.getByRole("button", { name: "Close settings" }).click()
  await app.window.getByRole("button", { name: "Execution environment" }).click()
  await expect(app.window.getByRole("option", { name: "E2E cloud" })).toBeVisible()
  await app.window.keyboard.press("Escape")

  await app.window.getByRole("button", { name: "Account menu" }).click()
  await app.window.getByRole("menuitem", { name: "Settings" }).click()
  await app.window.getByRole("button", { name: /^Devices/ }).click()
  app.window.once("dialog", (dialog) => dialog.accept())
  await app.window.getByRole("button", { name: "Delete" }).click()
  await expect(environment).toHaveCount(0)
})
