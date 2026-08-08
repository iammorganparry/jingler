import { readFileSync } from "node:fs"
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

const pairClive = async (app: LaunchedApp): Promise<void> => {
  await expect(appShell(app.window)).toBeVisible()
  await openDevices(app.window)
  await app.window.getByRole("button", { name: "Add environment" }).click()
  await app.window.getByRole("button", { name: /^SSH\b/ }).click()
  await expect(app.window.getByText("clive.local", { exact: true })).toBeVisible()
  await app.window.getByText("clive.local", { exact: true }).click()
  await app.window.getByRole("button", { name: "Connect environment" }).click()
  await expect(app.window.getByRole("status")).toContainText("clive.local")
  await app.window.keyboard.press("Escape")
  await app.window.getByRole("button", { name: "Refresh" }).click()
  await expect(app.window.getByText("online", { exact: true })).toBeVisible({ timeout: 15_000 })
  await app.window.getByRole("button", { name: "Close settings" }).click()
}

const selectComposerEnvironment = async (window: Page, name = "clive.local") => {
  await window.getByRole("button", { name: "Execution environment" }).click()
  await window.getByRole("menuitem", { name }).click()
}

const createRemoteSession = async (window: Page, title: string): Promise<string> => {
  await window.getByTestId("new-session").click()
  await expect(window.getByRole("heading", { name: "New session" })).toBeVisible()
  await window.getByRole("combobox").first().click()
  await window.getByRole("option", { name: "clive.local" }).click()
  await window.getByPlaceholder("Leave blank for agent naming").fill(title)
  await expect(window.getByRole("button", { name: "Create", exact: true })).toBeEnabled({ timeout: 15_000 })
  await window.getByRole("button", { name: "Create", exact: true }).click()
  const row = sessionRow(window, title)
  await expect(row).toBeVisible({ timeout: 20_000 })
  const testId = await row.getAttribute("data-testid")
  if (!testId?.startsWith("session-row-")) throw new Error("Remote session row has no stable id")
  return testId.slice("session-row-".length)
}

test("pairs clive.local through SSH without a remote Jingler login", async ({ launchApp }) => {
  const app = await launchApp({ configured: true, withRepo: true, remoteEnvironment: true })
  await pairClive(app)
  expect(app.deviceRelay?.sshClaims()).toBe(1)
  expect(app.deviceRelay?.desktopBearerForwarded()).toBe(false)
  const sshArgv = readFileSync(join(app.home, "ssh-invocations.jsonl"), "utf8")
  expect(sshArgv).toContain("BatchMode=yes")
  expect(sshArgv).toContain("clive.local")
})

test("selects a paired environment from the composer and reflects it in the sidebar", async ({ launchApp }) => {
  const app = await launchApp({
    configured: true,
    withRepo: true,
    remoteEnvironment: true,
    sessions: ({ repoPath }) => [localSession(repoPath)]
  })
  await pairClive(app)
  await selectComposerEnvironment(app.window)
  await expect(app.window.getByTestId("session-environment-session_local_abcdefgh")).toHaveText("clive.local")
  await expect(app.window.getByRole("button", { name: "Execution environment" })).toContainText("clive.local")
})

test("creates and runs a session on a paired environment", async ({ launchApp }) => {
  const app = await launchApp({ configured: true, withRepo: true, remoteEnvironment: true })
  await pairClive(app)
  const sessionId = await createRemoteSession(app.window, "Remote scripted task")
  const composer = app.window.getByPlaceholder("Message Claude…")
  await composer.fill("Reply from clive.local")
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
  await pairClive(app)
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
  await pairClive(app)
  await selectComposerEnvironment(app.window)
  await expect(app.window.getByRole("alert")).toContainText("Continue it as a new session")
  await app.window.getByRole("button", { name: "Continue there" }).click()
  await expect(sessionRow(app.window, "Local session continuation")).toBeVisible({ timeout: 20_000 })
  await expect(app.window.getByTestId("session-environment-session_local_abcdefgh")).toHaveCount(0)
  await expect(app.window.getByTestId("session-row-session_local_abcdefgh")).toBeVisible()
})

test("resumes a remote turn after relay interruption without duplicate execution", async ({ launchApp }) => {
  const app = await launchApp({ configured: true, withRepo: true, remoteEnvironment: true })
  await pairClive(app)
  const sessionId = await createRemoteSession(app.window, "Reconnect exactly once")
  const composer = app.window.getByPlaceholder("Message Claude…")
  await composer.fill("Complete once after reconnect")
  await composer.press("Enter")
  await expect.poll(() => app.deviceRelay?.commandAdmissions(sessionId, "Agent.run") ?? 0).toBe(1)
  app.deviceRelay?.interruptSession(sessionId)
  await expect(app.window.getByText("Claude", { exact: true })).toBeVisible({ timeout: 25_000 })
  expect(app.deviceRelay?.commandAdmissions(sessionId, "Agent.run")).toBe(1)
})

test("shows offline and incompatible paired environments", async ({ launchApp }) => {
  const app = await launchApp({ configured: true, withRepo: true, remoteEnvironment: true })
  await pairClive(app)
  app.deviceRelay?.setDeviceState("offline")
  await openDevices(app.window)
  await app.window.getByRole("button", { name: "Refresh" }).click()
  await expect(app.window.getByText("offline", { exact: true })).toBeVisible()
  app.deviceRelay?.setDeviceState("incompatible")
  await app.window.getByRole("button", { name: "Refresh" }).click()
  await expect(app.window.getByText("incompatible", { exact: true })).toBeVisible()
})

test("revokes a paired environment while preserving local sessions", async ({ launchApp }) => {
  const app = await launchApp({
    configured: true,
    withRepo: true,
    remoteEnvironment: true,
    sessions: ({ repoPath }) => [localSession(repoPath)]
  })
  await pairClive(app)
  await openDevices(app.window)
  app.window.once("dialog", (dialog) => dialog.accept())
  await app.window.getByRole("button", { name: "Revoke" }).click()
  await expect(app.window.getByText("No paired devices yet.")).toBeVisible()
  await app.window.getByRole("button", { name: "Close settings" }).click()
  await expect(sessionRow(app.window, "Local session")).toBeVisible()
  await app.window.getByRole("button", { name: "Execution environment" }).click()
  await expect(app.window.getByRole("menuitem", { name: /clive\.local/ })).toHaveCount(0)
})
