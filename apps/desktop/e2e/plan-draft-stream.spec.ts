import { existsSync } from "node:fs"
import { join } from "node:path"
import {
  appShell,
  expect,
  planDirectory,
  type SeedSession,
  test
} from "./fixtures.js"

const composerPlaceholder = /Message .+…/
// The read-only bar shows the live phase as a status pill (lower-case) rather
// than the removed sync indicator.
const transientStatus = /composing|validating/

const session = (
  id: string
): ((ctx: { repoPath: string }) => ReadonlyArray<SeedSession>) =>
  ({ repoPath }) => [
    {
      id,
      repo: "widget",
      branch: `jingler/${id}`,
      title: "Streamed plan",
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

test("a streamed plan opens beside chat, stays read-only, and promotes in place", async ({
  launchApp
}) => {
  const launched = await launchApp({
    configured: true,
    withRepo: true,
    sessions: session("s_streamed_plan")
  })
  const { window } = launched
  await expect(appShell(window)).toBeVisible()
  const planFile = join(
    planDirectory(launched.home, launched.repoPath),
    "current-plan.html"
  )

  const composer = window.getByPlaceholder(composerPlaceholder)
  await composer.fill("[[plan]] [[stream-plan]] refactor auth")
  await composer.press("Enter")

  // The first renderable transient opens the real Plan Review beside the live
  // transcript. It is not a revision yet, so no file or approval controls exist.
  await expect(window.getByTestId("composer")).toBeVisible()
  await expect(window.getByLabel("Resize plan")).toBeVisible()
  await expect(window.getByLabel("Plan document")).toBeVisible()
  await expect(window.getByTestId("plan-status-summary")).toContainText(
    transientStatus
  )
  expect(existsSync(planFile)).toBe(false)
  await expect(window.getByLabel("Plan approval options")).toHaveCount(0)

  // Composing streams the agent's HTML into the read-only document.
  await expect(window.getByText(/Move session token handling/)).toBeVisible()

  // Promotion swaps in the validated canonical revision: the Main step outline
  // takes over (with the stage titles) and the revision becomes approvable.
  await expect
    .poll(() => existsSync(planFile), { timeout: 20_000 })
    .toBe(true)
  await expect(
    window.getByText("Audit session middleware", { exact: true })
  ).toBeVisible({ timeout: 20_000 })
  await expect(window.getByTestId("plan-floating-actions")).toBeVisible()
})

test("later plan drafts respect a split the operator closed", async ({
  launchApp
}) => {
  const launched = await launchApp({
    configured: true,
    withRepo: true,
    sessions: session("s_plan_split_preference")
  })
  const { window } = launched
  await expect(appShell(window)).toBeVisible()
  const planFile = join(
    planDirectory(launched.home, launched.repoPath),
    "current-plan.html"
  )
  const composer = window.getByPlaceholder(composerPlaceholder)

  await composer.fill("[[plan]] [[stream-plan]] refactor auth")
  await composer.press("Enter")
  await expect(window.getByTestId("plan-split-column")).toBeVisible()
  await expect.poll(() => existsSync(planFile), { timeout: 20_000 }).toBe(true)

  await window
    .getByRole("button", { name: "Split plan beside conversation" })
    .click()
  await expect(window.getByTestId("plan-split-column")).toHaveCount(0)

  // A new chat owns a fresh conversation actor and therefore emits its own
  // first-draft nonce. Auto-presentation is session-scoped, so that new actor
  // must not override the split preference established above.
  await window.getByRole("button", { name: "New chat" }).click()
  const nextComposer = window.getByPlaceholder(composerPlaceholder)
  await nextComposer.fill("[[plan]] [[stream-plan]] revise auth")
  await nextComposer.press("Enter")
  await expect(
    window.getByRole("toolbar", { name: "Plan approval options" })
  ).toBeVisible({ timeout: 20_000 })
  await expect(window.getByTestId("plan-split-column")).toHaveCount(0)

  await window
    .getByRole("button", { name: "Split plan beside conversation" })
    .click()
  await expect(window.getByTestId("plan-split-column")).toBeVisible()
})

test("a closed plan split stays closed after an app restart", async ({
  launchApp
}) => {
  const first = await launchApp({
    configured: true,
    withRepo: true,
    sessions: session("s_restarted_plan_split_preference")
  })
  await expect(appShell(first.window)).toBeVisible()
  const composer = first.window.getByPlaceholder(composerPlaceholder)

  await composer.fill("[[plan]] [[stream-plan]] refactor auth")
  await composer.press("Enter")
  await expect(first.window.getByTestId("plan-split-column")).toBeVisible()
  await first.window
    .getByRole("button", { name: "Split plan beside conversation" })
    .click()
  await expect(first.window.getByTestId("plan-split-column")).toHaveCount(0)
  await first.app.close()

  const reopened = await launchApp({
    home: first.home,
    reposDir: first.reposDir,
    userDataDir: first.userDataDir,
    configured: true,
    withRepo: true
  })
  await expect(appShell(reopened.window)).toBeVisible()
  const nextComposer = reopened.window.getByPlaceholder(composerPlaceholder)
  await nextComposer.fill("[[plan]] [[stream-plan]] revise auth")
  await nextComposer.press("Enter")

  await expect(
    reopened.window.getByRole("toolbar", { name: "Plan approval options" })
  ).toBeVisible({ timeout: 20_000 })
  await expect(reopened.window.getByTestId("plan-split-column")).toHaveCount(0)
})
