import { appShell, expect, test, type SeedSession } from "./fixtures.js"
import { execFileSync } from "node:child_process"

const DEVICES_SECTION = /^Devices/
const MESSAGE_BOX = /Message/

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

test("selects the fixed authenticated Cloud execution target", async ({
  launchApp
}) => {
  const app = await launchApp({
    configured: true,
    withRepo: true,
    sessions: ({ repoPath }) => {
      execFileSync("git", ["remote", "add", "origin", "https://github.com/iammorganparry/jingler.git"], { cwd: repoPath })
      return [localSession(repoPath)]
    }
  })
  await expect(appShell(app.window)).toBeVisible()

  await app.window.getByRole("button", { name: "Account menu" }).click()
  await app.window.getByRole("menuitem", { name: "Settings" }).click()
  await app.window.getByRole("button", { name: DEVICES_SECTION }).click()

  const environment = app.window.getByText("Cloud", { exact: true })
  await expect(environment).toBeVisible()
  await expect(environment.locator("..").locator("..")).toContainText(
    "sandbox starts automatically per session"
  )
  await expect(
    app.window.getByRole("button", { name: "Add cloud environment" })
  ).toHaveCount(0)
  await expect(app.window.getByRole("button", { name: "Delete" })).toHaveCount(0)

  await app.window.getByRole("button", { name: "Close settings" }).click()
  await app.window.getByTestId("new-session").click()
  await expect(app.window.getByRole("heading", { name: "New session" })).toBeVisible()
  await app.window.getByRole("button", { name: "Execution environment" }).click()
  const cloudOption = app.window.getByRole("option", { name: "Cloud" })
  await expect(cloudOption.locator('[data-environment-icon="cloud"]')).toBeVisible()
  await cloudOption.click()
  await expect(app.window.getByText("harness unavailable")).toHaveCount(0)
  await expect(app.window.getByRole("button", { name: "Create workspace" })).toBeEnabled()
  await app.window.getByRole("button", { name: "Create workspace" }).click()
  const startup = app.window.getByTestId("cloud-startup-progress")
  await expect(startup).toBeVisible()
  await expect(startup.getByRole("heading", { name: "Starting your Cloud session" })).toBeVisible()
  await expect(app.window.getByRole("button", { name: "Close new session" })).toBeDisabled()
  await expect(startup.locator('[data-phase="checking-access"]')).toHaveAttribute("data-status", /active|complete/)
  await expect(startup.locator('[data-phase="starting-sandbox"]')).toHaveAttribute("data-status", "active")
  const pendingCloud = app.window.getByTestId("pending-cloud-session")
  await expect(pendingCloud).toContainText("Starting in Cloud · widget")
  await app.window.getByText("Managed environment picker", { exact: true }).click()
  await expect(startup).toBeHidden()
  await pendingCloud.click()
  await expect(startup).toBeVisible()
  await app.window.getByText("Managed environment picker", { exact: true }).click()
  await expect(startup).toBeHidden()

  const prompt = app.window.getByRole("textbox", { name: MESSAGE_BOX })
  await prompt.fill("Keep this turn active while I move it to Cloud.")
  await prompt.press("Enter")
  await expect(
    app.window.getByRole("button", { name: "Stop", exact: true })
  ).toBeVisible()
  await app.window.getByRole("button", { name: "Execution environment" }).click()
  await app.window.getByRole("option", { name: "Cloud" }).click()
  await expect(app.window.getByRole("alert")).toContainText("Stop the active turn")
  await expect(
    app.window.getByRole("button", { name: "Stop and continue there" })
  ).toBeVisible()
  await app.window.getByRole("button", {
    name: "Cancel environment continuation"
  }).click()
})
