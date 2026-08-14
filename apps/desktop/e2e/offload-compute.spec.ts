import { execFileSync } from "node:child_process"
import { writeFileSync } from "node:fs"
import { join } from "node:path"
import { appShell, expect, test, type SeedSession } from "./fixtures.js"
import { startFakeAuthServer } from "./fake-auth.js"

const session = (repoPath: string): SeedSession => ({
  id: "session_offload_compute_e2e",
  repo: "widget",
  branch: "main",
  title: "Offload compute",
  status: "idle",
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

const prepareRepository = (repoPath: string): ReadonlyArray<SeedSession> => {
  writeFileSync(join(repoPath, "package.json"), JSON.stringify({
    scripts: { typecheck: "printf 'local typecheck clean\\n'" }
  }))
  execFileSync("git", ["add", "package.json"], { cwd: repoPath })
  execFileSync("git", ["commit", "-qm", "add typecheck fixture"], { cwd: repoPath })
  execFileSync(
    "git",
    ["remote", "add", "origin", "https://github.com/jingler/example.git"],
    { cwd: repoPath }
  )
  return [session(repoPath)]
}

const sendOffloadPrompt = async (window: import("@playwright/test").Page) => {
  const composer = window.getByRole("textbox", { name: /Message/ })
  await composer.fill("[[offload-typecheck]] Run the typecheck.")
  await composer.press("Enter")
}

test("enables, primes, automatically routes, and restores Offload Compute status", async ({
  launchApp
}) => {
  const app = await launchApp({
    configured: true,
    withRepo: true,
    config: {
      offloadCompute: { enabled: false, explicitCommands: [] }
    },
    sessions: ({ repoPath }) => prepareRepository(repoPath)
  })
  await expect(appShell(app.window)).toBeVisible()

  await app.window.getByRole("button", { name: "Account menu" }).click()
  await app.window.getByRole("menuitem", { name: "Settings" }).click()
  await app.window.getByRole("button", { name: /^General/ }).click()
  const toggle = app.window.getByRole("switch", { name: "Offload Compute" })
  await expect(toggle).not.toBeChecked()
  await toggle.click()
  await expect(toggle).toBeChecked()
  await expect.poll(() => app.authServer.offloadRequests.map(({ kind }) => kind))
    .toContain("prime")
  await expect(app.window.getByText("Cloud compute is ready", { exact: false }))
    .toBeVisible()

  await app.window.getByRole("button", { name: "Close settings" }).click()
  await sendOffloadPrompt(app.window)
  const remoteTool = app.window.getByRole("button", { name: /command_execute/ })
  await expect(remoteTool).toBeVisible()
  await remoteTool.click()
  await expect(app.window.getByText("Offload Compute: preparing", { exact: false }))
    .toBeVisible()
  await expect(app.window.getByText("remote typecheck clean", { exact: false }))
    .toBeVisible()
  await expect(app.window.getByText("Typecheck completed on Offload Compute."))
    .toBeVisible()
  await expect.poll(() => app.authServer.offloadRequests.map(({ kind }) => kind))
    .toEqual(expect.arrayContaining(["prime", "admit", "upload", "events"]))

  const requestCount = app.authServer.offloadRequests.length
  await app.app.close()
  const reopened = await launchApp({
    home: app.home,
    reposDir: app.reposDir,
    userDataDir: app.userDataDir,
    configured: true,
    authServer: app.authServer
  })
  await expect(appShell(reopened.window)).toBeVisible()
  await expect(reopened.window.getByText("Typecheck completed on Offload Compute."))
    .toBeVisible()
  expect(reopened.authServer.offloadRequests).toHaveLength(requestCount)
  await reopened.window
    .getByTestId("session-row-session_offload_compute_e2e")
    .hover()
  await reopened.window.getByRole("button", { name: "Archive Offload compute" }).click()
  await expect.poll(() => reopened.authServer.offloadRequests.map(({ kind }) => kind))
    .toContain("destroy")
  const primesBeforeRestore = reopened.authServer.offloadRequests
    .filter(({ kind }) => kind === "prime").length
  await reopened.window.getByRole("button", { name: "Restore session" }).click()
  await expect.poll(() => reopened.authServer.offloadRequests
    .filter(({ kind }) => kind === "prime").length)
    .toBeGreaterThan(primesBeforeRestore)
})

test("keeps eligible commands local while Offload Compute is disabled", async ({
  launchApp
}) => {
  const app = await launchApp({
    configured: true,
    withRepo: true,
    config: {
      offloadCompute: { enabled: false, explicitCommands: [] }
    },
    sessions: ({ repoPath }) => prepareRepository(repoPath)
  })
  await expect(appShell(app.window)).toBeVisible()
  await sendOffloadPrompt(app.window)
  const localTool = app.window.getByRole("button", { name: /command_execute/ })
  await expect(localTool).toBeVisible()
  await localTool.click()
  await expect(app.window.getByText("pnpm: command not found", { exact: false }))
    .toBeVisible()
  expect(app.authServer.offloadRequests).toHaveLength(0)
})

test("cancels the active remote command through the existing Stop control", async ({
  launchApp
}) => {
  const authServer = await startFakeAuthServer({ offloadResult: "hold" })
  try {
    const app = await launchApp({
      authServer,
      configured: true,
      withRepo: true,
      config: {
        offloadCompute: { enabled: true, explicitCommands: [] }
      },
      sessions: ({ repoPath }) => prepareRepository(repoPath)
    })
    await expect(appShell(app.window)).toBeVisible()
    await sendOffloadPrompt(app.window)
    await expect.poll(() => authServer.offloadRequests.map(({ kind }) => kind))
      .toContain("events")
    const stop = app.window.getByRole("button", { name: "Stop", exact: true })
    await expect(stop).toBeVisible()
    await stop.click()
    await expect.poll(() => authServer.offloadRequests.map(({ kind }) => kind))
      .toContain("cancel")
  } finally {
    await authServer.close()
  }
})

test("reports remote failure and requires an explicit local retry", async ({
  launchApp
}) => {
  const authServer = await startFakeAuthServer({ offloadResult: "failed" })
  try {
    const app = await launchApp({
      authServer,
      configured: true,
      withRepo: true,
      config: {
        offloadCompute: { enabled: true, explicitCommands: [] }
      },
      sessions: ({ repoPath }) => prepareRepository(repoPath)
    })
    await expect(appShell(app.window)).toBeVisible()
    await sendOffloadPrompt(app.window)
    const failedTool = app.window.getByRole("button", { name: /command_execute/ })
    await expect(failedTool).toBeVisible()
    await failedTool.click()
    await expect(app.window.getByText("runLocally: true", { exact: false }))
      .toBeVisible()
    await expect(app.window.getByText("pnpm: command not found", { exact: false }))
      .toHaveCount(0)

    const composer = app.window.getByRole("textbox", { name: /Message/ })
    await composer.fill("Approved: [[offload-local-retry]] run it locally.")
    await composer.press("Enter")
    const tools = app.window.getByRole("button", { name: /command_execute/ })
    await expect(tools).toHaveCount(2)
    await tools.nth(1).click()
    await expect(app.window.getByText("pnpm: command not found", { exact: false }))
      .toBeVisible()
    expect(app.authServer.offloadRequests.filter(({ kind }) => kind === "admit"))
      .toHaveLength(1)
  } finally {
    await authServer.close()
  }
})
