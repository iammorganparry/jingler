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
const transientStatus = /Composing|Validating/
const planRevision = /^revision \d+$/

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
  await expect(window.getByRole("status")).toContainText(transientStatus)
  expect(existsSync(planFile)).toBe(false)
  await expect(window.getByLabel("Plan approval options")).toHaveCount(0)

  const editor = window.getByLabel("Plan document")
  await editor.evaluate((element) => {
    element.setAttribute("data-stream-editor", "same-instance")
  })
  await expect(
    window.getByText("Audit session middleware", { exact: true })
  ).toBeVisible()

  // Promotion swaps the validated canonical source into that same Tiptap
  // instance: no blank frame/remount, then the revision becomes approvable.
  await expect(window.getByRole("status")).toContainText("Synced", {
    timeout: 20_000
  })
  await expect
    .poll(() => existsSync(planFile), { timeout: 20_000 })
    .toBe(true)
  await expect(
    window.locator('[data-stream-editor="same-instance"]')
  ).toBeVisible()
  await expect(window.getByText(planRevision, { exact: true })).toBeVisible()
  await expect(window.getByTestId("plan-floating-actions")).toBeVisible()
})
