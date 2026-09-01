import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import type { ElectronApplication } from "@playwright/test"
import { appShell, expect, type LaunchedApp, type SeedSession, test } from "./fixtures.js"

const PI_FIXTURE = {
  scenarioId: "plan-mode",
  authRoute: "api-key" as const
}

const COMPOSER_PLACEHOLDER = /Message .+…/
const PLANNOTATOR_URL = /^jingler-plan:/

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

/** The plan review is a bundled custom-scheme view, never a localhost server. */
const reviewUrls = (app: ElectronApplication) =>
  app.evaluate(async ({ webContents }) =>
    webContents.getAllWebContents()
      .map((contents) => contents.getURL())
      .filter((url) => url.startsWith("jingler-plan:"))
  )

const reviewText = (app: ElectronApplication) =>
  app.evaluate(async ({ webContents }) => {
    const review = webContents.getAllWebContents()
      .find((contents) => contents.getURL().startsWith("jingler-plan:"))
    return review?.executeJavaScript("document.body.innerText") ?? ""
  })

const clickReviewButton = async (app: ElectronApplication, label: string) => {
  await expect.poll(() =>
    app.evaluate(async ({ webContents }, wanted) => {
      const review = webContents.getAllWebContents()
        .find((contents) => contents.getURL().startsWith("jingler-plan:"))
      return review?.executeJavaScript(`(() => {
        const button = [...document.querySelectorAll('button')]
          .find((candidate) => candidate.textContent?.includes(${JSON.stringify(wanted)}));
        if (!button) return false;
        button.click();
        return true;
      })()`) ?? false
    }, label),
  { timeout: 20_000 }).toBe(true)
}

const approveReview = (app: ElectronApplication) => clickReviewButton(app, "Approve")
const approveReviewStatus = (app: ElectronApplication) =>
  app.evaluate(async ({ webContents }) => {
    const review = webContents.getAllWebContents()
      .find((contents) => contents.getURL().startsWith("jingler-plan:"))
    return review?.executeJavaScript(
      "fetch('/api/approve', { method: 'POST' }).then((response) => response.status)"
    )
  })
const reviewSecurity = (app: ElectronApplication) =>
  app.evaluate(async ({ webContents }) => {
    const review = webContents.getAllWebContents()
      .find((contents) => contents.getURL().startsWith("jingler-plan:"))
    const popupDenied = await review?.executeJavaScript("window.open('https://example.com') === null")
    await review?.executeJavaScript("location.href = 'https://example.com'").catch(() => {})
    return { popupDenied, url: review?.getURL() }
  })

const reviseReview = (app: ElectronApplication) =>
  app.evaluate(async ({ webContents }) => {
    const review = webContents.getAllWebContents()
      .find((contents) => contents.getURL().startsWith("jingler-plan:"))
    await review?.executeJavaScript(`fetch('/api/deny', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ feedback: 'Keep the existing token format' })
    })`)
  })

const startPlanReview = async (launched: LaunchedApp) => {
  const composer = launched.window.getByPlaceholder(COMPOSER_PLACEHOLDER)
  await composer.click()
  await launched.window.keyboard.press("Shift+Tab")
  await launched.window.keyboard.press("Shift+Tab")
  await expect(launched.window.locator("[data-mode='plan']")).toContainText("Plan")
  await composer.fill("[[plan]] replace auth")
  await composer.press("Enter")
}

test("Plannotator reviews in a bundled Plan-tab view and drives progress", async ({
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
  const planTab = launched.window.getByTestId("view-tab-plan").first()
  await expect(planTab).toBeVisible({ timeout: 20_000 })
  await planTab.click()

  await expect(launched.window.getByTestId("plannotator-embedded-view")).toBeVisible()
  await expect.poll(() => reviewUrls(launched.app)).toHaveLength(1)
  await expect.poll(() => reviewText(launched.app)).toContain("Implement the auth change")
  const security = await reviewSecurity(launched.app)
  expect(security.popupDenied).toBe(true)
  expect(security.url).toMatch(PLANNOTATOR_URL)

  await approveReview(launched.app)
  await expect.poll(() => reviewText(launched.app)).not.toContain("Approve")
  await expect.poll(() => reviewUrls(launched.app)).toEqual([
    expect.stringMatching(/^jingler-plan:\/\/[^/]+\/$/)
  ])

  await launched.window.getByTestId("active-chat-tab").first().click()
  const transcriptCard = launched.window.getByTestId("plannotator-transcript-card")
  await expect(transcriptCard).toBeVisible()
  const completion = launched.window
    .getByText("Implemented and verified the approved plan.")
    .first()
  await expect(completion).toBeVisible({ timeout: 30_000 })
  await expect(launched.window.locator("[data-mode='auto']")).toContainText("Auto")
  await expect(launched.window.getByText("2/2")).toBeVisible({ timeout: 20_000 })

  const planRow = transcriptCard.locator("xpath=ancestor::*[@data-index][1]")
  await expect(planRow).toContainText("PLAN.md")
  await expect(transcriptCard.locator(
    "xpath=following::*[contains(normalize-space(.), 'Implemented and verified the approved plan.')]"
  ).first()).toBeVisible()
  await expect(launched.window.getByTestId("plan-approval-stage-plannotator-step-1"))
    .toHaveAttribute("data-status", "completed")
  await expect(launched.window.getByTestId("plan-progress-stage-plannotator-step-1"))
    .toContainText("Done")
  // The plan outlives its approval: the tab persists as a live progress surface.
  const persistentTab = launched.window.getByTestId("view-tab-plan").first()
  await expect(persistentTab).toBeVisible()
  await persistentTab.click()
  await expect.poll(() => readFileSync(join(launched.repoPath, "PLAN.md"), "utf8"))
    .toContain("- [x] Verify the auth change")
  await expect.poll(() => reviewText(launched.app)).toContain("Verify the auth change")
})

test("a hidden renderer cannot settle a review without acknowledging delivery", async ({
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

  const planTab = launched.window.getByTestId("view-tab-plan").first()
  await expect(planTab).toBeVisible({ timeout: 20_000 })
  await planTab.click()
  await expect.poll(() => reviewUrls(launched.app)).toHaveLength(1)
  await launched.window.getByRole("button", { name: "Split plan beside conversation" }).click()
  await expect(launched.window.getByTestId("plannotator-embedded-view")).toHaveCount(0)

  await expect(approveReviewStatus(launched.app)).resolves.toBe(503)

  await planTab.click()
  await expect(launched.window.getByTestId("plannotator-embedded-view")).toBeVisible()
  await approveReview(launched.app)
  await launched.window.getByTestId("active-chat-tab").first().click()
  await expect(launched.window.getByText("Implemented and verified the approved plan.").first())
    .toBeVisible({ timeout: 30_000 })
})

test("missing PLAN.md during execution fails closed without rejecting progress", async ({
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

  const planTab = launched.window.getByTestId("view-tab-plan").first()
  await expect(planTab).toBeVisible({ timeout: 20_000 })
  await planTab.click()
  await expect.poll(() => reviewUrls(launched.app)).toHaveLength(1)
  await approveReview(launched.app)

  await launched.window.getByTestId("active-chat-tab").first().click()
  await expect(launched.window.getByRole("tab", { name: "Plan 1/2" })).toBeVisible({
    timeout: 20_000
  })
  rmSync(join(launched.repoPath, "PLAN.md"))

  await expect(launched.window.getByText("Implemented and verified the approved plan.").first())
    .toBeVisible({ timeout: 30_000 })
  expect(existsSync(join(launched.repoPath, "PLAN.md"))).toBe(false)
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

  const planTab = launched.window.getByTestId("view-tab-plan").first()
  await expect(planTab).toBeVisible({ timeout: 20_000 })
  await planTab.click()
  await expect(launched.window.getByTestId("plannotator-embedded-view")).toBeVisible()
  await reviseReview(launched.app)

  // The denial goes back through the submit tool; the scripted agent rewrites
  // the SAME plan file in place and resubmits it for a second review.
  await expect.poll(() =>
    readFileSync(join(launched.repoPath, "PLAN.md"), "utf8"), { timeout: 30_000 }
  ).toContain("keeping the existing token format")
  await expect.poll(() => reviewText(launched.app), { timeout: 30_000 })
    .toContain("keeping the existing token format")
  await approveReview(launched.app)

  await launched.window.getByTestId("active-chat-tab").first().click()
  await expect(launched.window.getByText("Implemented and verified the approved plan.").first())
    .toBeVisible({ timeout: 30_000 })
  await expect(launched.window.getByText("2/2")).toBeVisible({ timeout: 20_000 })
})

test("a pending Plannotator review reopens in the bundled view after an Electron restart", async ({
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
  await expect(first.window.getByTestId("view-tab-plan").first())
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
  const planTab = reopened.window.getByTestId("view-tab-plan").first()
  await expect(planTab).toBeVisible({ timeout: 20_000 })
  await planTab.click()
  await expect(reopened.window.getByTestId("plannotator-embedded-view")).toBeVisible({ timeout: 30_000 })
  await expect.poll(() => reviewUrls(reopened.app)).toHaveLength(1)

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
  await approveReview(reopened.app)
  await reopened.window.getByTestId("active-chat-tab").first().click()
  await expect(reopened.window.getByText("Implemented and verified the approved plan.").first())
    .toBeVisible({ timeout: 30_000 })
})

test("closing a chat destroys its embedded Plannotator view", async ({ launchApp }) => {
  const launched = await launchApp({
    configured: true,
    withRepo: true,
    piFixture: PI_FIXTURE,
    sessions
  })
  await expect(appShell(launched.window)).toBeVisible()
  await startPlanReview(launched)
  const planTab = launched.window.getByTestId("view-tab-plan").first()
  await expect(planTab).toBeVisible({ timeout: 20_000 })
  await planTab.click()
  await expect.poll(() => reviewUrls(launched.app)).toHaveLength(1)

  await launched.window.getByRole("button", { name: "Close [[plan]] replace auth" }).click()
  await expect.poll(() => reviewUrls(launched.app), { timeout: 20_000 }).toEqual([])
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
    await expect(first.window.getByTestId("view-tab-plan").first())
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
    await expect(reopened.window.getByTestId("view-tab-plan")).toHaveCount(0)
    await expect(reopened.window.getByTestId("plan-task-list")).toHaveCount(0)
    expect(await reviewUrls(reopened.app)).toEqual([])
  })
}
