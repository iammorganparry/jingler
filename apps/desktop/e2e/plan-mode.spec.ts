import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import type { ElectronApplication } from "@playwright/test"
import { appShell, expect, type LaunchedApp, type SeedSession, test } from "./fixtures.js"

const PI_FIXTURE = {
  scenarioId: "plan-mode",
  authRoute: "api-key" as const
}

const COMPOSER_PLACEHOLDER = /Message .+…/

const sessions = ({ repoPath }: { repoPath: string }): ReadonlyArray<SeedSession> => [{
  id: "s_plannotator",
  repo: "widget",
  repoPath,
  branch: "main",
  title: "Plannotator workspace",
  status: "idle",
  connectionId: "jingler-e2e-connection",
  providerId: "jingler-e2e",
  modelId: "jingler-e2e/eval-model",
  diff: { added: 0, removed: 0 },
  prNumber: null,
  costUsd: 0,
  tokens: 0,
  updatedAt: "2026-08-27T00:00:00.000Z",
  worktreePath: repoPath,
  workspaceMode: "direct",
  chats: [{
    id: "s_plannotator_chat",
    title: null,
    createdAt: "2026-08-27T00:00:00.000Z",
    updatedAt: "2026-08-27T00:00:00.000Z",
    mode: "accept-edits",
    connectionId: "jingler-e2e-connection",
    providerId: "jingler-e2e",
    modelId: "jingler-e2e/eval-model"
  }],
  activeChatId: "s_plannotator_chat"
}]

/**
 * The plan review is fully native now — no Plannotator webview, no loopback
 * review server. Any localhost webContents during a plan review would mean the
 * deleted browser surface came back.
 */
const reviewUrls = (app: ElectronApplication) =>
  app.evaluate(async ({ webContents }) =>
    webContents.getAllWebContents()
      .map((contents) => contents.getURL())
      .filter((url) => url.startsWith("http://localhost:"))
  )

const startPlanReview = async (launched: LaunchedApp) => {
  const composer = launched.window.getByPlaceholder(COMPOSER_PLACEHOLDER)
  await composer.click()
  await launched.window.keyboard.press("Shift+Tab")
  await launched.window.keyboard.press("Shift+Tab")
  await expect(launched.window.locator("[data-mode='plan']")).toContainText("Plan")
  await composer.fill("[[plan]] replace auth")
  await composer.press("Enter")
}

test("Plannotator reviews natively inside the Plan tab and drives progress", async ({
  launchApp
}) => {
  const launched = await launchApp({
    configured: true,
    withRepo: true,
    piFixture: PI_FIXTURE,
    sessions
  })
  await expect(appShell(launched.window)).toBeVisible()
  await startPlanReview(launched)

  await expect.poll(() => existsSync(join(launched.repoPath, "PLAN.md")), {
    timeout: 20_000
  }).toBe(true)
  const planTab = launched.window.getByRole("button", { name: "Plan Review" }).first()
  await expect(planTab).toBeVisible({ timeout: 20_000 })
  await planTab.click()

  // The native document editor renders the projected checklist as stages, and
  // the floating actions carry the approval — nothing is a webview.
  const actions = launched.window.getByTestId("plan-floating-actions")
  await expect(actions).toBeVisible({ timeout: 20_000 })
  await expect(actions).toContainText("proposed")
  expect(await reviewUrls(launched.app)).toEqual([])

  await actions.getByRole("button", { name: "Approve" }).click()

  await launched.window.getByTestId("active-chat-tab").first().click()
  await expect(
    launched.window.getByText("Implemented and verified the approved plan.").first()
  ).toBeVisible({ timeout: 30_000 })
  await expect(launched.window.locator("[data-mode='auto']")).toContainText("Auto")
  await expect(launched.window.getByRole("button", { name: "Plan Review" })).toHaveCount(0)
  await expect(launched.window.getByText("2/2")).toBeVisible({ timeout: 20_000 })
})

test("Revise with agent denies the review and the same plan file is revised", async ({
  launchApp
}) => {
  const launched = await launchApp({
    configured: true,
    withRepo: true,
    piFixture: PI_FIXTURE,
    sessions
  })
  await expect(appShell(launched.window)).toBeVisible()
  await startPlanReview(launched)

  const planTab = launched.window.getByRole("button", { name: "Plan Review" }).first()
  await expect(planTab).toBeVisible({ timeout: 20_000 })
  await planTab.click()
  const actions = launched.window.getByTestId("plan-floating-actions")
  await expect(actions).toBeVisible({ timeout: 20_000 })

  await actions.getByRole("button", { name: "More plan actions" }).click()
  await launched.window.getByRole("menuitem", { name: "Revise with agent" }).click()

  // The denial goes back through the submit tool; the scripted agent rewrites
  // the SAME plan file in place and resubmits it for a second review.
  await expect.poll(() =>
    readFileSync(join(launched.repoPath, "PLAN.md"), "utf8"), { timeout: 30_000 }
  ).toContain("keeping the existing token format")
  const revisedActions = launched.window.getByTestId("plan-floating-actions")
  await expect(revisedActions).toBeVisible({ timeout: 30_000 })
  await revisedActions.getByRole("button", { name: "Approve" }).click()

  await launched.window.getByTestId("active-chat-tab").first().click()
  await expect(launched.window.getByText("Implemented and verified the approved plan.").first())
    .toBeVisible({ timeout: 30_000 })
  await expect(launched.window.getByText("2/2")).toBeVisible({ timeout: 20_000 })
})

test("a pending Plannotator review reopens natively after an Electron restart", async ({
  launchApp
}) => {
  const first = await launchApp({
    configured: true,
    withRepo: true,
    piFixture: PI_FIXTURE,
    sessions
  })
  await expect(appShell(first.window)).toBeVisible()
  await startPlanReview(first)
  await expect(first.window.getByRole("button", { name: "Plan Review" }).first())
    .toBeVisible({ timeout: 20_000 })
  await first.app.close()

  const reopened = await launchApp({
    configured: true,
    withRepo: true,
    home: first.home,
    reposDir: first.reposDir,
    userDataDir: first.userDataDir,
    authServer: first.authServer,
    githubServer: first.githubServer,
    githubRelay: first.githubRelay
  })
  await expect(appShell(reopened.window)).toBeVisible()
  const planTab = reopened.window.getByRole("button", { name: "Plan Review" }).first()
  await expect(planTab).toBeVisible({ timeout: 20_000 })
  await planTab.click()
  const actions = reopened.window.getByTestId("plan-floating-actions")
  await expect(actions).toBeVisible({ timeout: 30_000 })
  expect(await reviewUrls(reopened.app)).toEqual([])

  await reopened.window.getByTestId("active-chat-tab").first().click()
  await expect(reopened.window.getByText("0/2")).toBeVisible({ timeout: 20_000 })
  const transcriptCard = reopened.window.getByTestId("plannotator-transcript-card")
  await expect(transcriptCard).toContainText("Implement the auth change")
  await expect(transcriptCard).toContainText("Verify the auth change")
  const planDrawer = reopened.window.getByTestId("plan-task-list")
  await expect(planDrawer).toContainText("Implement the auth change")
  await expect(planDrawer).toContainText("Verify the auth change")

  // The resumed review must still be decidable over the native channel.
  await planTab.click()
  await actions.getByRole("button", { name: "Approve" }).click()
  await reopened.window.getByTestId("active-chat-tab").first().click()
  await expect(reopened.window.getByText("Implemented and verified the approved plan.").first())
    .toBeVisible({ timeout: 30_000 })
})

for (const recoveryCase of [
  {
    name: "missing",
    prepare: (path: string) => rmSync(path),
    message: "Cannot resume plan review: PLAN.md no longer exists."
  },
  {
    name: "empty",
    prepare: (path: string) => writeFileSync(path, ""),
    message: "Cannot resume plan review: PLAN.md is empty."
  }
]) {
  test(`pending review fails closed when PLAN.md is ${recoveryCase.name}`, async ({ launchApp }) => {
    const first = await launchApp({
      configured: true,
      withRepo: true,
      piFixture: PI_FIXTURE,
      sessions
    })
    await expect(appShell(first.window)).toBeVisible()
    await startPlanReview(first)
    await expect(first.window.getByRole("button", { name: "Plan Review" }).first())
      .toBeVisible({ timeout: 20_000 })
    await first.app.close()

    recoveryCase.prepare(join(first.repoPath, "PLAN.md"))
    const reopened = await launchApp({
      configured: true,
      withRepo: true,
      home: first.home,
      reposDir: first.reposDir,
      userDataDir: first.userDataDir,
      authServer: first.authServer,
      githubServer: first.githubServer,
      githubRelay: first.githubRelay
    })
    await expect(appShell(reopened.window)).toBeVisible()
    await expect(reopened.window.getByText(recoveryCase.message)).toBeVisible({ timeout: 20_000 })
    await expect(reopened.window.getByText("Implemented and verified the approved plan."))
      .toHaveCount(0)
    await expect(reopened.window.getByRole("button", { name: "Plan Review" })).toHaveCount(0)
    await expect(reopened.window.getByTestId("plan-task-list")).toHaveCount(0)
    expect(await reviewUrls(reopened.app)).toEqual([])
  })
}
