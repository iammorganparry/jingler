import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import {
  appShell,
  expect,
  type LaunchedApp,
  planDirectory,
  type SeedSession,
  test
} from "./fixtures.js"

const composerPlaceholder = /Message .+…/
// The read-only bar shows the live phase as a status pill (lower-case); the
// sync/revision indicators were removed with the in-place editor.
const transientStatus = /composing|validating/

const session = ({ repoPath }: { repoPath: string }): ReadonlyArray<SeedSession> => [
  {
    id: "s_plan_collaboration",
    repo: "widget",
    branch: "chore/plan-collaboration",
    title: "Collaborative plan",
    status: "idle",
    cli: "claude",
    diff: { added: 0, removed: 0 },
    prNumber: null,
    costUsd: 0,
    tokens: 0,
    updatedAt: "2026-07-31T00:00:00.000Z",
    worktreePath: repoPath,
    mode: "accept-edits"
  }
]

const currentPlanPath = (launched: LaunchedApp): string =>
  join(planDirectory(launched.home, launched.repoPath), "current-plan.json")

const columnRatio = async (
  column: ReturnType<LaunchedApp["window"]["getByTestId"]>
): Promise<number> => {
  const box = await column.boundingBox()
  expect(box).not.toBeNull()
  const rowWidth = await column.evaluate(
    (element) => element.parentElement?.getBoundingClientRect().width ?? 0
  )
  return box!.width / rowWidth
}

test("streaming plan collaboration survives promotion and reload", async ({
  launchApp
}) => {
  const launched = await launchApp({
    configured: true,
    withRepo: true,
    sessions: session
  })
  const { window } = launched
  const planFile = currentPlanPath(launched)
  await expect(appShell(window)).toBeVisible()
  await window.evaluate(() => localStorage.removeItem("sb.split.plan.ratio"))

  const composer = window.getByPlaceholder(composerPlaceholder)
  await composer.fill(
    "[[plan]] [[stream-plan]] [[active-plan-agent]] refactor auth"
  )
  await composer.press("Enter")

  // The first renderable transient opens beside the live transcript with the
  // plan taking two thirds and chat taking one third.
  // It is a read-only projection, not a canonical plan revision yet.
  const planColumn = window.getByTestId("plan-split-column")
  await expect(planColumn).toBeVisible()
  await expect(window.getByTestId("composer")).toBeVisible()
  await expect(window.getByTestId("plan-status-summary")).toContainText(
    transientStatus
  )
  // While the status is still composing the transient is a live projection, not a
  // canonical revision: the DTO is streamed, not yet promoted to `current-plan.json`,
  // and there is no approval gate. (Checked before the title, which also renders
  // once the plan promotes.)
  expect(existsSync(planFile)).toBe(false)
  await expect(window.getByLabel("Plan approval options")).toHaveCount(0)
  // The composing transient renders the streamed DTO as the read-only step outline,
  // so a stage title is live before promotion (the plan title needs a promoted doc).
  await expect(
    window.getByText("Audit session middleware", { exact: true }).first()
  ).toBeVisible({ timeout: 20_000 })

  const initialRatio = await columnRatio(planColumn)
  expect(initialRatio).toBeGreaterThan(0.64)
  expect(initialRatio).toBeLessThan(0.69)

  // Resize while snapshots are still arriving. Later transient updates and the
  // canonical promotion must preserve this operator-selected ratio.
  const divider = window.getByLabel("Resize plan")
  const handle = await divider.boundingBox()
  expect(handle).not.toBeNull()
  await window.mouse.move(handle!.x, handle!.y + handle!.height / 2)
  await window.mouse.down()
  // At this viewport the default already leaves chat at its 360px safety floor,
  // so resize toward chat rather than asking the plan column to exceed its clamp.
  await window.mouse.move(handle!.x + 90, handle!.y + handle!.height / 2)
  await window.mouse.up()
  const resizedRatio = await columnRatio(planColumn)
  expect(resizedRatio).toBeLessThan(initialRatio - 0.04)

  // Composing tolerant-parses the streamed partial DTO into the read-only outline.
  await expect(
    window.getByText("Audit session middleware", { exact: true }).first()
  ).toBeVisible({ timeout: 20_000 })

  // Promotion swaps in the validated canonical revision — the Main step outline.
  await expect.poll(() => existsSync(planFile), { timeout: 20_000 }).toBe(true)
  await expect
    .poll(() => readFileSync(planFile, "utf8"))
    .toContain('"id": "s_06"')
  await expect(
    window.getByText("Audit session middleware", { exact: true }).first()
  ).toBeVisible({ timeout: 20_000 })
  expect(await columnRatio(planColumn)).toBeCloseTo(resizedRatio, 2)

  // Reopening the split restores the same saved ratio.
  const splitToggle = window.getByRole("button", {
    name: "Split plan beside conversation"
  })
  await splitToggle.click()
  await expect(planColumn).toHaveCount(0)
  await splitToggle.click()
  expect(
    await columnRatio(window.getByTestId("plan-split-column"))
  ).toBeCloseTo(resizedRatio, 2)

  // Opening Plan Review from its tab defaults back to the responsive split.
  await splitToggle.click()
  await window
    .getByTestId("view-tab-controls")
    .getByRole("button", { name: "Plan Review", exact: true })
    .click()
  await expect(window.getByTestId("plan-split-column")).toBeVisible()
  await expect(window.getByTestId("composer")).toBeVisible()
  const review = window.getByTestId("plan-review-container")
  const floatingActions = window.getByTestId("plan-floating-actions")
  await expect(floatingActions).toBeVisible()
  const statusSummary = floatingActions.getByTestId("plan-status-summary")
  await expect(statusSummary).toContainText("proposed")
  await expect(window.getByTestId("plan-status-summary")).toHaveCount(1)
  const reviewBox = await review.boundingBox()
  const actionsBox = await floatingActions.boundingBox()
  expect(reviewBox).not.toBeNull()
  expect(actionsBox).not.toBeNull()
  expect(actionsBox!.y).toBeGreaterThan(
    reviewBox!.y + reviewBox!.height / 2
  )
  expect(
    Math.abs(
      actionsBox!.x + actionsBox!.width / 2 -
        (reviewBox!.x + reviewBox!.width / 2)
    )
  ).toBeLessThan(24)

  // Comment on a step, then @mention the active scripted child agent from the
  // thread's REPLY composer — mentions are a reply-only affordance now (a
  // create-comment is batched via revisePlan with no delivery, so it carries no
  // mentions). The reply dispatches through the real Plan RPC, relays through the
  // owning run, and appends the returned agent response to this durable thread.
  await window.getByRole("button", { name: "Comment on this step" }).first().click()
  await window.getByLabel("Add a comment…").fill("Please confirm the rollout.")
  await window.getByRole("button", { name: "Send reply" }).click()

  const marker = window.getByRole("button", { name: "Comment thread" })
  await expect(marker).toBeVisible({ timeout: 10_000 })
  await marker.click()
  const thread = window.locator("[data-plan-comment-thread]")
  const reply = thread.getByLabel("Reply to this thread…")
  await reply.fill("Confirming with @")
  const mentions = window.getByRole("listbox", { name: "Mention an agent" })
  await expect(mentions.getByText("Sub-agent · Active")).toBeVisible()
  await mentions.getByText("Explore", { exact: true }).click()
  await thread.getByRole("button", { name: "Send reply" }).click()

  await expect(thread.getByText(/Confirming with @Explore/)).toBeVisible()
  await expect(
    thread.getByText(
      "Explore confirms the anchored rollout guidance is safe to keep."
    )
  ).toBeVisible({ timeout: 10_000 })
  await expect(thread.getByText("Sent").first()).toBeVisible()
  await thread.getByRole("button", { name: "Resolve" }).click()
  await expect(thread.getByText("Thread resolved")).toBeVisible({
    timeout: 10_000
  })

  // Restart the actual Electron app against the same persisted home. Both the
  // promoted canonical plan and its resolved conversation must round-trip.
  await launched.app.close()
  const reopened = await launchApp({
    home: launched.home,
    reposDir: launched.reposDir,
    userDataDir: launched.userDataDir,
    configured: true,
    withRepo: true
  })
  await expect(appShell(reopened.window)).toBeVisible()
  await reopened.window.getByRole("button", { name: "Plan Review" }).first().click()
  await expect(
    reopened.window.getByText("Audit session middleware", { exact: true }).first()
  ).toBeVisible()

  const persistedMarker = reopened.window.getByRole("button", {
    name: "Comment thread"
  })
  await expect(persistedMarker).toBeVisible()
  await persistedMarker.click()
  const persistedThread = reopened.window.locator("[data-plan-comment-thread]")
  await expect(persistedThread.getByText(/Confirming with @Explore/)).toBeVisible()
  await expect(
    persistedThread.getByText(
      "Explore confirms the anchored rollout guidance is safe to keep."
    )
  ).toBeVisible()
  await expect(persistedThread.getByText("Thread resolved")).toBeVisible()
})

test("narrow streamed plans use full-width review chrome", async ({ launchApp }) => {
  const launched = await launchApp({
    configured: true,
    withRepo: true,
    sessions: session
  })
  const { window } = launched
  await expect(appShell(window)).toBeVisible()
  await window.setViewportSize({ width: 700, height: 720 })
  await window.waitForTimeout(120)

  const composer = window.getByPlaceholder(composerPlaceholder)
  await composer.fill("[[plan]] [[stream-plan]] refactor auth")
  await composer.press("Enter")

  await expect(window.getByTestId("plan-review-container")).toBeVisible()
  await expect(window.getByTestId("composer")).toHaveCount(0)
  await expect(window.getByRole("navigation", { name: "Plan minimap" })).toHaveCount(0)
  const controls = window.getByTestId("plan-floating-actions")
  await expect(controls).toBeVisible()
  const statusSummary = controls.getByTestId("plan-status-summary")
  await expect(statusSummary).toBeVisible()
  await expect(statusSummary).toContainText(/composing|validating|proposed/)
  await expect(window.getByTestId("plan-status-summary")).toHaveCount(1)
  await expect(window.getByLabel("Resize plan")).toHaveCount(0)
})
