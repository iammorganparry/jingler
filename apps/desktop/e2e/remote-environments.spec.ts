import { nativeCliEndpointId, ProviderId, ProviderModelId, type AgentEndpointCatalog } from "@jingler/core"
import { execFileSync } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"
import { join, resolve } from "node:path"
import type { Page } from "@playwright/test"
import { addProject, appShell, expect, sessionRow, test, type LaunchedApp, type SeedSession } from "./fixtures.js"

const addFixtureOrigin = ({ reposDir, repoPath }: { reposDir: string; repoPath: string }) => {
  const origin = join(reposDir, "widget-origin.git")
  execFileSync("git", ["clone", "--bare", repoPath, origin])
  execFileSync("git", ["remote", "add", "origin", origin], { cwd: repoPath })
}

const localSession = (
  repoPath: string,
  overrides: Partial<SeedSession> = {}
): SeedSession => ({
  id: "session_local_abcdefgh",
  repo: "widget",
  branch: "main",
  title: "Local session",
  status: "idle",
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
  await expect(app.window.getByRole("status")).toContainText("buildbox", { timeout: 30_000 })
  await app.window.keyboard.press("Escape")
  await app.window.getByRole("button", { name: "Refresh" }).click()
  await expect.poll(() => app.deviceRelay?.ready() ?? false, { timeout: 15_000 }).toBe(true)
  await app.window.getByRole("button", { name: "Close settings" }).click()
}

const selectComposerEnvironment = async (window: Page, name = "buildbox") => {
  await window.getByRole("button", { name: "Execution environment" }).click()
  await window.getByRole("option", { name: new RegExp(name) }).click()
}

const createRemoteWorkspace = async (window: Page, projectPath: string): Promise<string> => {
  await window.getByTestId("new-session").click()
  await expect(window.getByRole("heading", { name: "New session" })).toBeVisible()
  await addProject(window, projectPath)
  await window.getByRole("button", { name: "Execution environment" }).click()
  await window.getByRole("option", { name: "buildbox" }).click()
  await expect(window.getByRole("button", { name: "Create workspace" })).toBeEnabled({ timeout: 20_000 })
  await window.getByRole("button", { name: "Create workspace" }).click()
  const startup = window.getByTestId("environment-startup-progress")
  await expect(startup).toBeVisible()
  await expect(
    startup.getByRole("heading", { name: "Starting your session on buildbox" })
  ).toBeVisible()
  await expect(startup.locator('[data-phase="resolving-repository"]')).toHaveAttribute(
    "data-status",
    /active|complete/
  )
  const pending = window.getByTestId("pending-environment-session")
  await expect(pending).toContainText("Starting on buildbox · widget")
  const row = window.locator("[data-testid^='session-row-']").first()
  await expect(row).toBeVisible({ timeout: 20_000 })
  const testId = await row.getAttribute("data-testid")
  if (!testId?.startsWith("session-row-")) throw new Error("Remote session row has no stable id")
  return testId.slice("session-row-".length)
}

test("saves an owned buildbox SSH configuration without sharing codes", async ({ launchApp }) => {
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
    seed: addFixtureOrigin
  })
  await enrollBuildbox(app)
  const sessionId = await createRemoteWorkspace(app.window, app.repoPath)
  const remoteRepo = join(app.deviceHome!, "repos", "widget")
  expect(existsSync(join(remoteRepo, ".git"))).toBe(true)
  const remoteProjects = JSON.parse(readFileSync(join(app.deviceHome!, "jingler", "projects.json"), "utf8"))
  expect(remoteProjects).toEqual([expect.objectContaining({ name: "widget", path: remoteRepo })])
  const composer = app.window.getByPlaceholder("Message the agent…")
  await composer.fill("Reply from buildbox")
  await composer.press("Enter")
  await expect.poll(() => app.deviceRelay?.commandAdmissions(sessionId, "Agent.run") ?? 0).toBe(1)
})

test("returns a new session to Local while remote project preparation is pending", async ({ launchApp }) => {
  const app = await launchApp({
    configured: true,
    withRepo: true,
    remoteEnvironment: true
  })
  await enrollBuildbox(app)
  await app.window.getByTestId("new-session").click()
  await addProject(app.window, app.repoPath)
  await selectComposerEnvironment(app.window)

  const environment = app.window.getByRole("button", { name: "Execution environment" })
  await app.window.getByRole("button", { name: "Auto", exact: true }).click()
  await app.window.getByRole("option", { name: "Ask Before Actions" }).click()
  await app.window.getByRole("button", { name: "Thinking strength" }).click()
  await app.window.getByRole("option", { name: "High", exact: true }).click()
  await expect(environment).toBeEnabled()
  await environment.click()
  await app.window.getByRole("option", { name: "Local" }).click()

  await expect(environment).toContainText("Local")
  await expect(app.window.getByRole("button", { name: "Ask Before Actions" })).toBeVisible()
  await expect(app.window.getByRole("button", { name: "Thinking strength" })).toContainText("High")
  await expect(app.window.getByRole("button", { name: "Base branch" })).toContainText("main")
  await expect(app.window.getByRole("button", { name: "Create workspace" })).toBeEnabled()
})

test("offers a confirmed environment handoff during an active turn", async ({ launchApp }) => {
  const app = await launchApp({
    configured: true,
    withRepo: true,
    remoteEnvironment: true,
    sessions: ({ repoPath }) => [localSession(repoPath)]
  })
  await enrollBuildbox(app)
  const composer = app.window.getByPlaceholder("Message the agent…")
  await composer.fill("[[queue-hold]] Hold the environment while this runs")
  await composer.press("Enter")
  await expect(app.window.getByTestId("session-row-session_local_abcdefgh").getByText(/Thinking|Running/)).toBeVisible()
  const environment = app.window.getByRole("button", { name: "Execution environment" })
  await expect(environment).toContainText("Local")
  await environment.click()
  await app.window.getByRole("option", { name: /buildbox/ }).click()
  await expect(app.window.getByRole("alert")).toContainText("Stop the active turn")
  await app.window.getByRole("button", { name: "Cancel" }).click()
  await expect(environment).toContainText("Local")
})

test("continues an existing session on another environment without mutating the source", async ({ launchApp }) => {
  const app = await launchApp({
    configured: true,
    withRepo: true,
    remoteEnvironment: true,
    seed: addFixtureOrigin,
    sessions: ({ repoPath }) => [localSession(repoPath, { diff: { added: 1, removed: 0 }, tokens: 10 })]
  })
  await enrollBuildbox(app)
  await selectComposerEnvironment(app.window)
  await expect(app.window.getByRole("alert")).toContainText("Continue it as a new session")
  await app.window.getByRole("button", { name: "Continue there" }).click()
  await expect.poll(() => JSON.parse(
    readFileSync(join(app.home, "jingler", "sessions.json"), "utf8")
  ).map((session: { title: string }) => session.title), { timeout: 20_000 })
    .toContain("Local session continuation")
  await app.window.getByRole("button", { name: "Unassigned", exact: true }).click()
  await expect(sessionRow(app.window, "Local session continuation")).toBeVisible({ timeout: 20_000 })
  await app.window.getByRole("button", { name: "widget", exact: true }).click()
  await expect(app.window.getByTestId("session-environment-session_local_abcdefgh")).toHaveCount(0)
  await expect(app.window.getByTestId("session-row-session_local_abcdefgh")).toBeVisible()
})

test("resumes a remote turn after relay interruption without duplicate execution", async ({ launchApp }) => {
  const app = await launchApp({
    configured: true,
    withRepo: true,
    remoteEnvironment: true,
    remoteRepo: false,
    seed: addFixtureOrigin
  })
  await enrollBuildbox(app)
  const sessionId = await createRemoteWorkspace(app.window, app.repoPath)
  const composer = app.window.getByPlaceholder("Message the agent…")
  await composer.fill("Complete once after reconnect")
  await composer.press("Enter")
  await expect.poll(() => app.deviceRelay?.commandAdmissions(sessionId, "Agent.run") ?? 0).toBe(1)
  app.deviceRelay?.interruptSession(sessionId)
  await app.window.waitForTimeout(1_000)
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
  await expect(app.window.getByText("Cloud", { exact: true })).toBeVisible()
  await expect(app.window.getByText("buildbox", { exact: true })).toHaveCount(0)
  await app.window.getByRole("button", { name: "Close settings" }).click()
  await expect(sessionRow(app.window, "Local session")).toBeVisible()
  await app.window.getByRole("button", { name: "Execution environment" }).click()
  await expect(app.window.getByRole("option", { name: /buildbox/ })).toHaveCount(0)
})


test("refreshes the paired device endpoint catalog and checks remote auth status", async ({ launchApp }) => {
  const app = await launchApp({
    configured: true, withRepo: true, remoteEnvironment: true,
    piFixture: { scenarioId: "composer-capabilities", authRoute: "openai-codex-oauth" }
  })
  await enrollBuildbox(app)
  await expect.poll(() => app.deviceRelay?.endpointRequests()).toContain("auth-status")
  await app.window.getByRole("button", { name: "Account menu" }).click()
  await app.window.getByRole("menuitem", { name: "Settings" }).click()
  await app.window.getByRole("button", { name: /Providers/ }).click()
  await app.window.getByRole("button", { name: "Refresh", exact: true }).click()
  await expect.poll(() => app.deviceRelay?.endpointRequests()).toContain("refresh")
  await expect(app.window.getByRole("button", { name: "Refresh", exact: true })).toBeEnabled({ timeout: 15_000 })
})

for (const status of ["missing", "unsupported"] as const) {
test(`refreshes a ${status} remote-only endpoint and selects it on its target`, async ({ launchApp }) => {
  const app = await launchApp({
    configured: true, withRepo: true, remoteEnvironment: true,
    seed: addFixtureOrigin,
    e2eEnv: { JINGLER_CLAUDE_BINARY: "/nonexistent/local-claude" },
    deviceE2eEnv: {
      JINGLER_CLAUDE_BINARY: resolve(
        import.meta.dirname,
        "../../../packages/cli-adapters/src/runtime/agent/fixtures/claude-tools.mjs"
      )
    }
  })
  const endpointId = nativeCliEndpointId("device_buildbox_abcdefgh", "claude")
  const catalog: AgentEndpointCatalog = { refreshedAt: "2026-09-25T00:00:00Z", stale: false, endpoints: [{
    endpoint: { id: endpointId, runtimeId: "claude", targetId: "device_buildbox_abcdefgh", label: "Remote-only Claude", status, version: "2.1.282",
      features: { steer: "none", planReview: false, subagentFleet: false, backgroundTasks: false } },
    models: [{ providerId: ProviderId.make("anthropic"), id: ProviderModelId.make("anthropic/opus"), label: "Remote-only Opus",
      capabilities: { contextWindow: 200000, reasoning: [], vision: false }, verification: "unverified", status: "unavailable", selectable: false, certificationKey: null }]
  }] }
  await enrollBuildbox(app)
  const sessionId = await createRemoteWorkspace(app.window, app.repoPath)
  await expect(app.window.getByPlaceholder("Message the agent…")).toBeVisible({ timeout: 20_000 })

  app.deviceRelay!.setEndpointCatalog(catalog)
  await app.window.getByRole("button", { name: "Account menu" }).click()
  await app.window.getByRole("menuitem", { name: "Settings" }).click()
  await app.window.getByRole("button", { name: /Providers/ }).click()
  await app.window.getByRole("button", { name: "Refresh", exact: true }).click()
  await expect(app.window.getByRole("button", { name: "Refresh", exact: true })).toBeEnabled({ timeout: 15_000 })
  await app.window.getByRole("button", { name: "Close settings" }).click()
  const model = app.window.getByRole("button", { name: /^Model:/ })
  await expect(model).toBeDisabled()

  app.deviceRelay!.setEndpointCatalog({ ...catalog, endpoints: catalog.endpoints.map(entry => ({
    endpoint: { ...entry.endpoint, status: "ready" }, models: entry.models.map(model => ({ ...model, status: "ready", selectable: true }))
  })) })
  await app.window.getByRole("button", { name: "Account menu" }).click()
  await app.window.getByRole("menuitem", { name: "Settings" }).click()
  await app.window.getByRole("button", { name: /Providers/ }).click()
  await app.window.getByRole("button", { name: "Refresh", exact: true }).click()
  await expect(app.window.getByRole("button", { name: "Refresh", exact: true })).toBeEnabled({ timeout: 15_000 })
  await app.window.getByRole("button", { name: "Close settings" }).click()
  await model.click()
  await expect(app.window.getByText("Remote-only Claude", { exact: true })).toBeVisible()
  await app.window.getByRole("option", { name: /^Remote-only Opus/ }).click()
  await expect.poll(() => JSON.parse(readFileSync(join(app.home, "jingler", "sessions.json"), "utf8"))
    .find((session: { id: string }) => session.id === sessionId).endpointId).toBe(endpointId)
})
}
