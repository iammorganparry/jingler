import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
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

/** Plan review is a native React surface inside the main window. */
const review = (launched: LaunchedApp) => launched.window.getByTestId("plan-review")
const reviewText = (launched: LaunchedApp) => review(launched).innerText().catch(() => "")

const approveReview = async (launched: LaunchedApp) => {
  await review(launched).getByRole("button", { name: "Approve", exact: true }).click()
}

const reviseReview = async (launched: LaunchedApp) => {
  await review(launched).getByRole("textbox", { name: "General feedback" }).fill(
    "For Implement auth (implement-auth), keep the existing token format instead of replacing it."
  )
  await review(launched).getByRole("button", { name: "Request changes" }).click()
}

const startPlanReview = async (launched: LaunchedApp) => {
  const skipImport = launched.window.getByRole("button", { name: "Skip import" })
  if (await skipImport.isVisible()) await skipImport.click()
  const composer = launched.window.getByPlaceholder(COMPOSER_PLACEHOLDER)
  await composer.click()
  await launched.window.keyboard.press("Shift+Tab")
  await launched.window.keyboard.press("Shift+Tab")
  await expect(launched.window.locator("[data-mode='plan']")).toContainText("Plan")
  await composer.fill("[[plan]] replace auth")
  await composer.press("Enter")
}

test("projects explicit deliverable stages without treating overview headings as work", async ({
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

  await expect(review(launched)).toBeVisible()
  await expect.poll(() => reviewText(launched)).toContain("Implement the auth change")
  // Proposed diffs, typed tests, and the test strategy render natively.
  await expect(review(launched).getByRole("region", { name: "Proposed change to src/auth.ts" }))
    .toBeVisible()
  await expect(review(launched).getByRole("table", { name: "Implement auth acceptance" }))
    .toContainText("src/auth.test.ts::implements auth")
  await expect(review(launched).getByRole("heading", { name: "Test strategy" })).toBeVisible()

  await approveReview(launched)
  await expect(review(launched).getByRole("button", { name: "Approve", exact: true })).toHaveCount(0)

  await launched.window.getByRole("button", { name: "[[plan]] replace auth", exact: true }).click()
  const transcriptCard = launched.window.getByTestId("plannotator-transcript-card")
  await expect(transcriptCard).toBeVisible()
  await expect(transcriptCard.locator('[data-testid^="plan-approval-stage-"]')).toHaveCount(2)
  await expect(transcriptCard.getByTestId("plan-approval-stage-implement-auth")).toBeVisible()
  await expect(transcriptCard.getByTestId("plan-approval-stage-verify-auth")).toBeVisible()
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
  await expect(launched.window.getByTestId("plan-approval-stage-implement-auth"))
    .toHaveAttribute("data-status", "completed")
  await expect(launched.window.getByTestId("plan-progress-stage-implement-auth"))
    .toContainText("Done")
  // The plan outlives its approval: the tab persists as a live progress surface.
  const persistentTab = launched.window.getByTestId("view-tab-plan").first()
  await expect(persistentTab).toBeVisible()
  await persistentTab.click()
  await expect.poll(() => readFileSync(join(launched.repoPath, "PLAN.md"), "utf8"))
    .toContain("- [x] Verify the auth change")
  await expect.poll(() => reviewText(launched)).toContain("Verify the auth change")
})

test("diagram node opens linked stage", async ({ launchApp }) => {
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

  const verifyHeading = review(launched).getByRole("heading", { name: "Verify auth", exact: true })
  await expect(verifyHeading).not.toBeInViewport()
  await review(launched).getByRole("link", { name: "Open stage verify-auth" }).click()
  await expect(verifyHeading).toBeInViewport({ timeout: 5_000 })
})

test("a new review in the same chat is presented and can be approved", async ({
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
  await expect.poll(() => reviewText(launched)).toContain("Implement the auth change")
  await approveReview(launched)
  await launched.window.getByRole("button", { name: "[[plan]] replace auth", exact: true }).click()
  await expect(launched.window.getByText("Implemented and verified the approved plan.").first())
    .toBeVisible({ timeout: 30_000 })

  const composer = launched.window.getByPlaceholder(COMPOSER_PLACEHOLDER)
  await composer.click()
  await launched.window.keyboard.press("Shift+Tab")
  await expect(launched.window.locator("[data-mode='plan']")).toContainText("Plan")
  await composer.fill("[[plan]] revise auth again")
  await composer.press("Enter")

  await expect(review(launched)).toBeVisible({ timeout: 20_000 })
  await planTab.click()
  await expect(review(launched).getByRole("button", { name: "Approve", exact: true }))
    .toBeVisible({ timeout: 20_000 })
  await approveReview(launched)
  await launched.window.getByRole("button", { name: "[[plan]] replace auth", exact: true }).click()
  await expect.poll(() =>
    launched.window.getByText("Implemented and verified the approved plan.").count(),
  { timeout: 30_000 }).toBeGreaterThan(1)
})

test("closing the Plan tab keeps a pending review approvable", async ({
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
  await expect(review(launched)).toBeVisible()
  await launched.window.getByRole("button", { name: "Close Plan" }).click()
  await expect(review(launched)).toHaveCount(0)
  await expect(launched.window.getByText("Implemented and verified the approved plan."))
    .toHaveCount(0)

  await planTab.click()
  await expect(review(launched)).toBeVisible()
  await approveReview(launched)
  await launched.window.getByRole("button", { name: "[[plan]] replace auth", exact: true }).click()
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
  await expect(review(launched)).toBeVisible()
  await approveReview(launched)

  await launched.window.getByRole("button", { name: "[[plan]] replace auth", exact: true }).click()
  await expect(launched.window.getByRole("tab", { name: "Plan 1/2" })).toBeVisible({
    timeout: 20_000
  })
  rmSync(join(launched.repoPath, "PLAN.md"))

  await expect(launched.window.getByText("Implemented and verified the approved plan.").first())
    .toBeVisible({ timeout: 30_000 })
  expect(existsSync(join(launched.repoPath, "PLAN.md"))).toBe(false)
})

test("revises one stage approach through native review feedback", async ({
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
  await expect(review(launched)).toBeVisible()
  await expect.poll(() => reviewText(launched))
    .toContain("The implementation replaces the token format")
  const originalPlan = readFileSync(join(launched.repoPath, "PLAN.md"), "utf8")
  await reviseReview(launched)

  // The denial goes back through the submit tool; the scripted agent rewrites
  // the SAME plan file in place and resubmits it for a second review.
  await expect.poll(() =>
    readFileSync(join(launched.repoPath, "PLAN.md"), "utf8"), { timeout: 30_000 }
  ).toContain("keeping the existing token format")
  await expect.poll(() => reviewText(launched), { timeout: 30_000 })
    .toContain("keeping the existing token format")
  const revisedPlan = readFileSync(join(launched.repoPath, "PLAN.md"), "utf8")
  expect(revisedPlan.match(/<!-- id: [\w-]+ -->/g)).toEqual(
    originalPlan.match(/<!-- id: [\w-]+ -->/g)
  )
  expect(revisedPlan.split("## Verify auth")[1]).toBe(originalPlan.split("## Verify auth")[1])
  await expect.poll(() => reviewText(launched))
    .toContain("The implementation preserves compatibility")
  await approveReview(launched)

  await launched.window.getByRole("button", { name: "[[plan]] replace auth", exact: true }).click()
  await expect(launched.window.getByText("Implemented and verified the approved plan.").first())
    .toBeVisible({ timeout: 30_000 })
  await expect(launched.window.getByText("2/2")).toBeVisible({ timeout: 20_000 })
})

test("main-chat feedback revises a pending Plannotator review", async ({ launchApp }) => {
  const launched = await launchApp({
    configured: true,
    withRepo: true,
    piFixture: PI_FIXTURE,
    sessions
  })
  await expect(appShell(launched.window)).toBeVisible()
  await startPlanReview(launched)

  await expect(launched.window.getByTestId("view-tab-plan").first()).toBeVisible({
    timeout: 20_000
  })
  await launched.window.getByRole("button", { name: "[[plan]] replace auth", exact: true }).click()
  const composer = launched.window.getByPlaceholder("Queue a message while the agent works…")
  await composer.fill("Keep the existing token format")
  await composer.press("Enter")

  await expect.poll(() =>
    readFileSync(join(launched.repoPath, "PLAN.md"), "utf8"), { timeout: 30_000 }
  ).toContain("keeping the existing token format")
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
  const firstPlanTab = first.window.getByTestId("view-tab-plan").first()
  await expect(firstPlanTab).toBeVisible({ timeout: 20_000 })
  await firstPlanTab.click()
  await expect.poll(() => reviewText(first)).toContain("Implement the auth change")
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
  await expect(review(reopened)).toBeVisible({ timeout: 30_000 })
  await expect.poll(() => reviewText(reopened)).toContain("Implement the auth change")

  await reopened.window.getByRole("button", { name: "[[plan]] replace auth", exact: true }).click()
  await expect(reopened.window.getByText("0/2")).toBeVisible({ timeout: 20_000 })
  const transcriptCard = reopened.window.getByTestId("plannotator-transcript-card")
  await expect(transcriptCard).toContainText("Implement the auth change")
  await expect(transcriptCard).toContainText("Verify the auth change")
  const planDrawer = reopened.window.getByTestId("plan-task-list")
  await expect(planDrawer).toContainText("Implement auth")
  await expect(planDrawer).toContainText("Verify auth")

  // The resumed review must still be decidable over the native channel.
  await planTab.click()
  await approveReview(reopened)
  await reopened.window.getByRole("button", { name: "[[plan]] replace auth", exact: true }).click()
  await expect(reopened.window.getByText("Implemented and verified the approved plan.").first())
    .toBeVisible({ timeout: 30_000 })
})

test("closing a chat removes its plan review", async ({ launchApp }) => {
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
  await expect(review(launched)).toBeVisible()

  await launched.window.getByRole("button", { name: "Close [[plan]] replace auth" }).click()
  await expect(review(launched)).toHaveCount(0, { timeout: 20_000 })
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
    await expect(review(reopened)).toHaveCount(0)
  })
}
