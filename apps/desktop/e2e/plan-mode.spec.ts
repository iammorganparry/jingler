import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { appShell, expect, type LaunchedApp, type LaunchOptions, type SeedSession, test } from "./fixtures.js"

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

const expandTechnicalDetails = async (launched: LaunchedApp, index: number) => {
  await review(launched).getByText("Technical details", { exact: true }).nth(index).click()
}

const approveReview = async (launched: LaunchedApp) => {
  await review(launched).getByRole("button", { name: "Approve", exact: true }).click()
}

const reviseReview = async (launched: LaunchedApp) => {
  await review(launched).getByRole("textbox", { name: "General feedback" }).fill(
    "For Implement auth (implement-auth), keep the existing token format instead of replacing it."
  )
  await review(launched).getByRole("button", { name: "Request changes" }).click()
}

const startPlanReview = async (launched: LaunchedApp, prompt = "[[plan]] replace auth") => {
  const skipImport = launched.window.getByRole("button", { name: "Skip import" })
  if (await skipImport.isVisible()) await skipImport.click()
  const composer = launched.window.getByPlaceholder(COMPOSER_PLACEHOLDER)
  await composer.click()
  await launched.window.keyboard.press("Shift+Tab")
  await launched.window.keyboard.press("Shift+Tab")
  await expect(launched.window.locator("[data-mode='plan']")).toContainText("Plan")
  await composer.fill(prompt)
  await composer.press("Enter")
}

const planFile = (launched: LaunchedApp): string => {
  const path = join(launched.repoPath, "PLAN.md")
  return existsSync(path) ? readFileSync(path, "utf8") : ""
}

const openPlanTab = async (launched: LaunchedApp) => {
  const planTab = launched.window.getByTestId("view-tab-plan").first()
  await expect(planTab).toBeVisible({ timeout: 20_000 })
  await planTab.click()
  await expect(review(launched)).toBeVisible()
  return planTab
}

const launchPlanMode = async (launchApp: (options?: LaunchOptions) => Promise<LaunchedApp>) => {
  const launched = await launchApp({ configured: true, withRepo: true, piFixture: PI_FIXTURE, sessions })
  await expect(appShell(launched.window)).toBeVisible()
  return launched
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
  await expandTechnicalDetails(launched, 0)
  // Proposed diffs, typed tests, and the test strategy render natively.
  await expect(review(launched).getByRole("region", { name: "Proposed change to src/auth.ts" }))
    .toBeVisible()
  await expect(review(launched).getByRole("region", { name: "Implement auth acceptance criteria" }))
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
  // The composer is back in Auto. Asserted on its mode attribute: split beside
  // the plan, the chat pane is narrow and the mode chip drops its word label.
  await expect(launched.window.locator("[data-mode]").first()).toHaveAttribute("data-mode", "auto")
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

test("selection comments reach the agent and the revision diff shows what changed", async ({ launchApp }) => {
  const launched = await launchPlanMode(launchApp)
  await startPlanReview(launched)
  await openPlanTab(launched)
  // First review: nothing to compare against yet.
  await expect(review(launched).getByRole("button", { name: /Changes since revision/ })).toHaveCount(0)

  const intent = review(launched)
    .getByRole("region", { name: "Implement auth", exact: true })
    .getByText("Auth tokens use the new format through the existing entry point.", { exact: true })
  await intent.click({ clickCount: 3 })
  await review(launched).getByRole("button", { name: "Add comment" }).click()
  await review(launched).getByRole("textbox", { name: "Comment" }).fill("Keep the existing token format.")
  await review(launched).getByRole("button", { name: "Save comment" }).click()
  await expect(review(launched).getByRole("complementary", { name: "Plan comments" }))
    .toContainText("Keep the existing token format.")
  await review(launched).getByRole("button", { name: "Request changes" }).click()

  // The fixture agent echoes every quoted anchor it received into the rewrite.
  await expect.poll(() => readFileSync(join(launched.repoPath, "PLAN.md"), "utf8"), { timeout: 30_000 })
    .toContain("Reviewer quoted: Auth tokens use the new format through the existing entry point.")

  const toggle = review(launched).getByRole("button", { name: /Changes since revision/ })
  await expect(toggle).toBeVisible({ timeout: 30_000 })
  await toggle.click()
  const changes = review(launched).getByRole("region", { name: "Changes since the previous revision" })
  await expect(changes.getByText("Reviewer quoted: Auth tokens use the new format through the existing entry point.")).toBeVisible()
  await expect(changes.getByText("- Replace the token format", { exact: false }).first()).toBeVisible()
  await review(launched).getByRole("button", { name: "Hide changes" }).click()
  await expect(changes).toHaveCount(0)

  await approveReview(launched)
  await launched.window.getByRole("button", { name: "[[plan]] replace auth", exact: true }).click()
  await expect(launched.window.getByText("Implemented and verified the approved plan.").first())
    .toBeVisible({ timeout: 30_000 })
})

test("diff and diagram file links open Files; diagrams pan, zoom and go fullscreen", async ({ launchApp }) => {
  const launched = await launchPlanMode(launchApp)
  await startPlanReview(launched)
  await openPlanTab(launched)
  await expandTechnicalDetails(launched, 1)

  const readmeChange = review(launched).getByRole("region", { name: "Proposed change to README.md" })
  await expect(readmeChange).toBeVisible()
  // src/auth.ts is not tracked in the fixture repo, so it must not render as a link.
  await expect(review(launched).getByRole("button", { name: "Open src/auth.ts" })).toHaveCount(0)
  await review(launched).getByRole("button", { name: "Open README.md" }).click()
  await expect(launched.window.getByTestId("view-tab-files").first()).toHaveAttribute("aria-current", "page")

  await openPlanTab(launched)
  const stage = review(launched).getByRole("region", { name: "Implement auth", exact: true })
  const canvas = stage.getByTestId("mermaid-canvas")
  await expect(canvas).toBeVisible()
  await stage.getByRole("button", { name: "Zoom in" }).click()
  await expect(canvas).toHaveAttribute("style", /scale\(1\.25\)/)
  const viewport = canvas.locator("xpath=..")
  const point = await viewport.evaluate((element) => {
    const box = element.getBoundingClientRect()
    for (let y = box.bottom - 8; y > box.top; y -= 8) {
      for (let x = box.left + 8; x < box.right; x += 8) {
        const target = document.elementFromPoint(x, y)
        if (target !== null && element.contains(target) && target.closest("[role=link]") === null) return { x, y }
      }
    }
    return null
  })
  expect(point).not.toBeNull()
  const { x, y } = point!
  await launched.window.mouse.move(x, y)
  await launched.window.mouse.down()
  await launched.window.mouse.move(x - 60, y - 20, { steps: 5 })
  await launched.window.mouse.up()
  await expect(canvas).not.toHaveAttribute("style", /translate\(0px, 0px\)/)
  await stage.getByRole("button", { name: "Reset view" }).click()
  await expect(canvas).toHaveAttribute("style", /translate\(0px, 0px\) scale\(1\)/)

  await stage.getByRole("button", { name: "Fullscreen" }).click()
  const dialog = launched.window.getByRole("dialog")
  await expect(dialog).toBeVisible()
  await dialog.getByRole("link", { name: "Open file README.md" }).click()
  await expect(dialog).toHaveCount(0)
  await expect(launched.window.getByTestId("view-tab-files").first()).toHaveAttribute("aria-current", "page")
})

test("submission rejects a plan with an unsafe diff path and no test strategy", async ({ launchApp }) => {
  const launched = await launchPlanMode(launchApp)
  await startPlanReview(launched, "[[plan]] [[invalid-plan]] replace auth")

  // The fixture agent copies the validator's errors into the fixed plan it resubmits.
  await expect.poll(() => planFile(launched), { timeout: 30_000 })
    .toContain('Fixed validation error: Plan needs a "## Test strategy" section.')
  const fixed = readFileSync(join(launched.repoPath, "PLAN.md"), "utf8")
  expect(fixed).toContain('proposes a change to unsafe path "../outside.ts"')
  expect(fixed).not.toContain("diff path=../outside.ts")

  await openPlanTab(launched)
  await expect(review(launched).getByRole("heading", { name: "Test strategy" })).toBeVisible()
  await approveReview(launched)
  await expect(review(launched).getByRole("button", { name: "Approve", exact: true })).toHaveCount(0)
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
  await expandTechnicalDetails(launched, 0)
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
  await expandTechnicalDetails(launched, 0)
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
