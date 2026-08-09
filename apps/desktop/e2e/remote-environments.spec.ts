import { execFileSync } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import type { Page } from "@playwright/test"
import { appShell, expect, sessionRow, test, type LaunchedApp, type SeedSession } from "./fixtures.js"

const localSession = (
  repoPath: string,
  overrides: Partial<SeedSession> = {}
): SeedSession => ({
  id: "session_local_abcdefgh",
  repo: "widget",
  branch: "main",
  title: "Local session",
  status: "idle",
  cli: "claude",
  diff: { added: 0, removed: 0 },
  prNumber: null,
  costUsd: 0,
  tokens: 0,
  updatedAt: "2026-08-08T00:00:00.000Z",
  worktreePath: repoPath,
  repoPath,
  baseBranch: "main",
  mode: "auto",
  ...overrides
})

const openDevices = async (window: Page): Promise<void> => {
  await window.getByRole("button", { name: "Account menu" }).click()
  await window.getByRole("menuitem", { name: "Settings" }).click()
  await window.getByRole("button", { name: /^Devices/ }).click()
  await expect(window.getByRole("heading", { name: "Devices" })).toBeVisible()
}

const enrollBuildbox = async (app: LaunchedApp): Promise<void> => {
  await expect(appShell(app.window)).toBeVisible()
  await openDevices(app.window)
  await app.window.getByRole("button", { name: "Add owned machine" }).click()
  await expect(app.window.getByRole("button", { name: /Remote link/i })).toHaveCount(0)
  await expect(app.window.getByLabel("SSH host or alias")).toBeVisible()
  await expect(app.window.getByText("buildbox", { exact: true })).toBeVisible()
  await app.window.getByText("buildbox", { exact: true }).click()
  await app.window.getByRole("button", { name: "Connect environment" }).click()
  await expect(app.window.getByRole("status")).toContainText("buildbox")
  await app.window.keyboard.press("Escape")
  await app.window.getByRole("button", { name: "Refresh" }).click()
  await expect(app.window.getByText("online", { exact: true })).toBeVisible({ timeout: 15_000 })
  await app.window.getByRole("button", { name: "Close settings" }).click()
}

const selectComposerEnvironment = async (window: Page, name = "buildbox") => {
  await window.getByRole("button", { name: "Execution environment" }).click()
  await window.getByRole("option", { name: new RegExp(name) }).click()
}

const createRemoteWorkspace = async (window: Page): Promise<string> => {
  await window.getByTestId("new-session").click()
  await expect(window.getByRole("heading", { name: "New session" })).toBeVisible()
  await window.getByRole("button", { name: "Execution environment" }).click()
  await window.getByRole("option", { name: "buildbox" }).click()
  await expect(window.getByRole("button", { name: "Create workspace" })).toBeEnabled({ timeout: 20_000 })
  await window.getByRole("button", { name: "Create workspace" }).click()
  const row = sessionRow(window, "Untitled session")
  await expect(row).toBeVisible({ timeout: 20_000 })
  const testId = await row.getAttribute("data-testid")
  if (!testId?.startsWith("session-row-")) throw new Error("Remote session row has no stable id")
  return testId.slice("session-row-".length)
}

test("enrolls an account-owned buildbox through SSH without sharing codes", async ({ launchApp }) => {
  const app = await launchApp({ configured: true, withRepo: true, remoteEnvironment: true })
  await enrollBuildbox(app)
  expect(app.deviceRelay?.sshClaims()).toBe(1)
  expect(app.deviceRelay?.desktopBearerForwarded()).toBe(false)
  const sshArgv = readFileSync(join(app.home, "ssh-invocations.jsonl"), "utf8")
  expect(sshArgv).toContain("BatchMode=yes")
  expect(sshArgv).toContain("buildbox")
  expect(sshArgv).not.toContain("jingler-e2e@buildbox")
  expect(sshArgv).not.toContain('"-p"')
})

test("selects an account-owned environment from the composer and reflects it in the sidebar", async ({ launchApp }) => {
  const app = await launchApp({
    configured: true,
    withRepo: true,
    remoteEnvironment: true,
    sessions: ({ repoPath }) => [localSession(repoPath)]
  })
  await enrollBuildbox(app)
  await expect(
    app.window.getByRole("button", { name: "Execution environment" }).locator('[data-environment-icon="local"]')
  ).toBeVisible()
  await selectComposerEnvironment(app.window)
  await expect(app.window.getByTestId("session-environment-session_local_abcdefgh")).toHaveText("buildbox")
  await expect(app.window.getByRole("button", { name: "Execution environment" })).toContainText("buildbox")
  await expect(
    app.window.getByRole("button", { name: "Execution environment" }).locator('[data-environment-icon="remote"]')
  ).toBeVisible()
})

test("clones a missing project and creates a workspace on an account-owned environment", async ({ launchApp }) => {
  const app = await launchApp({
    configured: true,
    withRepo: true,
    remoteEnvironment: true,
    remoteRepo: false,
    seed: ({ reposDir, repoPath }) => {
      const origin = join(reposDir, "widget-origin.git")
      execFileSync("git", ["clone", "--bare", repoPath, origin])
      execFileSync("git", ["remote", "add", "origin", origin], { cwd: repoPath })
    }
  })
  await enrollBuildbox(app)
  const sessionId = await createRemoteWorkspace(app.window)
  const remoteRepo = join(app.deviceHome!, "repos", "widget")
  expect(existsSync(join(remoteRepo, ".git"))).toBe(true)
  const remoteProjects = JSON.parse(readFileSync(join(app.deviceHome!, "jingler", "projects.json"), "utf8"))
  expect(remoteProjects).toEqual([expect.objectContaining({ name: "widget", path: remoteRepo })])
  const composer = app.window.getByPlaceholder("Message Claude…")
  await composer.fill("Reply from buildbox")
  await composer.press("Enter")
  await expect(app.window.getByText("Claude", { exact: true })).toBeVisible({ timeout: 20_000 })
  await expect.poll(() => app.deviceRelay?.commandAdmissions(sessionId, "Agent.run") ?? 0).toBe(1)
})

test("prevents changing environment during an active turn", async ({ launchApp }) => {
  const app = await launchApp({
    configured: true,
    withRepo: true,
    remoteEnvironment: true,
    sessions: ({ repoPath }) => [localSession(repoPath)]
  })
  await enrollBuildbox(app)
  const composer = app.window.getByPlaceholder("Message Claude…")
  await composer.fill("Hold the environment while this runs")
  await composer.press("Enter")
  await expect(app.window.getByTestId("session-row-session_local_abcdefgh").getByText(/Thinking|Running/)).toBeVisible()
  await expect(app.window.getByRole("button", { name: "Execution environment" })).toHaveCount(0)
})

test("continues an existing session on another environment without mutating the source", async ({ launchApp }) => {
  const app = await launchApp({
    configured: true,
    withRepo: true,
    remoteEnvironment: true,
    sessions: ({ repoPath }) => [localSession(repoPath, { diff: { added: 1, removed: 0 }, tokens: 10 })]
  })
  await enrollBuildbox(app)
  await selectComposerEnvironment(app.window)
  await expect(app.window.getByRole("alert")).toContainText("Continue it as a new session")
  await app.window.getByRole("button", { name: "Continue there" }).click()
  await expect(sessionRow(app.window, "Local session continuation")).toBeVisible({ timeout: 20_000 })
  await expect(app.window.getByTestId("session-environment-session_local_abcdefgh")).toHaveCount(0)
  await expect(app.window.getByTestId("session-row-session_local_abcdefgh")).toBeVisible()
})

test("resumes a remote turn after relay interruption without duplicate execution", async ({ launchApp }) => {
  const app = await launchApp({
    configured: true,
    withRepo: true,
    remoteEnvironment: true,
    remoteRepo: false,
    seed: ({ reposDir, repoPath }) => {
      const origin = join(reposDir, "widget-origin.git")
      execFileSync("git", ["clone", "--bare", repoPath, origin])
      execFileSync("git", ["remote", "add", "origin", origin], { cwd: repoPath })
    }
  })
  await enrollBuildbox(app)
  const sessionId = await createRemoteWorkspace(app.window)
  const composer = app.window.getByPlaceholder("Message Claude…")
  await composer.fill("Complete once after reconnect")
  await composer.press("Enter")
  await expect.poll(() => app.deviceRelay?.commandAdmissions(sessionId, "Agent.run") ?? 0).toBe(1)
  app.deviceRelay?.interruptSession(sessionId)
  await expect(app.window.getByText("Claude", { exact: true })).toBeVisible({ timeout: 25_000 })
  expect(app.deviceRelay?.commandAdmissions(sessionId, "Agent.run")).toBe(1)
})

test("shows offline and incompatible account-owned environments", async ({ launchApp }) => {
  const app = await launchApp({ configured: true, withRepo: true, remoteEnvironment: true })
  await enrollBuildbox(app)
  app.deviceRelay?.setDeviceState("offline")
  await openDevices(app.window)
  await app.window.getByRole("button", { name: "Refresh" }).click()
  await expect(app.window.getByText("offline", { exact: true })).toBeVisible()
  app.deviceRelay?.setDeviceState("incompatible")
  await app.window.getByRole("button", { name: "Refresh" }).click()
  await expect(app.window.getByText("incompatible", { exact: true })).toBeVisible()
})

test("revokes an account-owned environment while preserving local sessions", async ({ launchApp }) => {
  const app = await launchApp({
    configured: true,
    withRepo: true,
    remoteEnvironment: true,
    sessions: ({ repoPath }) => [localSession(repoPath)]
  })
  await enrollBuildbox(app)
  await openDevices(app.window)
  app.window.once("dialog", (dialog) => dialog.accept())
  await app.window.getByRole("button", { name: "Revoke" }).click()
  await expect(app.window.getByText("No owned machines yet.")).toBeVisible()
  await app.window.getByRole("button", { name: "Close settings" }).click()
  await expect(sessionRow(app.window, "Local session")).toBeVisible()
  await app.window.getByRole("button", { name: "Execution environment" }).click()
  await expect(app.window.getByRole("option", { name: /buildbox/ })).toHaveCount(0)
})
