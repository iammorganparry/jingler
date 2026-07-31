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
const openPrStage = /Open PR #482/
const transientStatus = /Composing|Validating/
const planRevision = /^revision \d+$/

const session = ({ repoPath }: { repoPath: string }): ReadonlyArray<SeedSession> => [
  {
    id: "s_plan_collaboration",
    repo: "widget",
    branch: "jingler/plan-collaboration",
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
  join(planDirectory(launched.home, launched.repoPath), "current-plan.html")

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

  // The first renderable transient opens beside the live transcript at 50/50.
  // It is a read-only projection, not a canonical plan revision yet.
  const planColumn = window.getByTestId("plan-split-column")
  await expect(planColumn).toBeVisible()
  await expect(window.getByTestId("composer")).toBeVisible()
  await expect(window.getByRole("status")).toContainText(transientStatus)
  await expect(
    window.getByText("PRD: Refactor auth flow", { exact: true })
  ).toBeVisible()
  expect(existsSync(planFile)).toBe(false)
  await expect(window.getByLabel("Plan approval options")).toHaveCount(0)

  const initialRatio = await columnRatio(planColumn)
  expect(initialRatio).toBeGreaterThan(0.48)
  expect(initialRatio).toBeLessThan(0.52)

  // Resize while snapshots are still arriving. Later transient updates and the
  // canonical promotion must preserve this operator-selected ratio.
  const divider = window.getByLabel("Resize plan")
  const handle = await divider.boundingBox()
  expect(handle).not.toBeNull()
  await window.mouse.move(handle!.x, handle!.y + handle!.height / 2)
  await window.mouse.down()
  await window.mouse.move(handle!.x - 90, handle!.y + handle!.height / 2)
  await window.mouse.up()
  const resizedRatio = await columnRatio(planColumn)
  expect(resizedRatio).toBeGreaterThan(initialRatio + 0.04)

  await expect(
    window.getByText("Audit session middleware", { exact: true })
  ).toBeVisible()
  await expect(window.getByRole("status")).toContainText("Synced", {
    timeout: 20_000
  })
  await expect.poll(() => existsSync(planFile), { timeout: 20_000 }).toBe(true)
  await expect
    .poll(() => readFileSync(planFile, "utf8"))
    .toContain('data-stage="s_06"')
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

  // Full-width Plan Review exposes minimap navigation and the bottom-centred
  // action surface rather than reserving a fixed toolbar row at the top.
  await splitToggle.click()
  await window
    .getByTestId("view-tab-controls")
    .getByRole("button", { name: "Plan Review", exact: true })
    .click()
  const minimap = window.getByRole("navigation", { name: "Plan minimap" })
  const review = window.getByTestId("plan-review-container")
  const floatingActions = window.getByTestId("plan-floating-actions")
  await expect(minimap).toBeVisible()
  await expect(floatingActions).toBeVisible()
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

  await minimap.getByRole("button", { name: openPrStage }).click()
  await expect(minimap.getByRole("button", { name: openPrStage })).toHaveAttribute(
    "aria-current",
    "location"
  )

  // Create an anchored thread and mention the active scripted child agent. The
  // dispatch goes through the real Plan RPC, relays through its owning run, and
  // appends the returned agent response to this same durable thread.
  const editor = window.getByLabel("Plan document")
  await editor
    .getByText(
      "Implement stages in order and keep the canonical revision recoverable.",
      { exact: true }
    )
    .selectText()
  await window.getByRole("button", { name: "Comment" }).click()
  const comment = window.getByLabel("Add a comment…")
  await comment.fill("Please confirm @")
  const mentions = window.getByRole("listbox", { name: "Mention an agent" })
  await expect(mentions.getByText("Orchestrator · Parked")).toBeVisible()
  await expect(mentions.getByText("Sub-agent · Active")).toBeVisible()
  await mentions.getByText("Explore", { exact: true }).click()
  await window.getByRole("button", { name: "Send reply" }).click()

  const marker = window.getByRole("button", { name: "user annotation, open" })
  await expect(marker).toBeVisible({ timeout: 10_000 })
  await marker.click()
  const thread = window.locator("[data-plan-comment-thread]")
  await expect(thread.getByText("Please confirm @Explore")).toBeVisible()
  await expect(
    thread.getByText(
      "Explore confirms the anchored rollout guidance is safe to keep."
    )
  ).toBeVisible({ timeout: 10_000 })
  await expect(thread.getByText("Sent").first()).toBeVisible()
  await thread.getByRole("button", { name: "Resolve" }).click()
  await expect(
    window.getByRole("button", { name: "user annotation, resolved" })
  ).toBeVisible({ timeout: 10_000 })

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
  await expect(reopened.window.getByLabel("Plan document")).toBeVisible()
  await expect(
    reopened.window.getByRole("heading", { name: "PRD: Refactor auth flow" })
  ).toBeVisible()
  await expect(
    reopened.window.getByText(planRevision, { exact: true })
  ).toBeVisible()
  await reopened.window
    .getByText(
      "Implement stages in order and keep the canonical revision recoverable.",
      { exact: true }
    )
    .scrollIntoViewIfNeeded()

  const persistedMarker = reopened.window.getByRole("button", {
    name: "user annotation, resolved"
  })
  await expect(persistedMarker).toBeVisible()
  await persistedMarker.click()
  const persistedThread = reopened.window.locator("[data-plan-comment-thread]")
  await expect(persistedThread.getByText("Please confirm @Explore")).toBeVisible()
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

  await expect(window.getByLabel("Plan document")).toBeVisible()
  await expect(window.getByTestId("composer")).toHaveCount(0)
  await expect(window.getByRole("navigation", { name: "Plan minimap" })).toHaveCount(0)
  await expect(window.getByTestId("plan-floating-actions")).toBeVisible()
  await expect(window.getByLabel("Resize plan")).toHaveCount(0)
})
