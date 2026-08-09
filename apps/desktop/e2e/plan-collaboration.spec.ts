import {
  appShell,
  expect,
  type SeedSession,
  test
} from "./fixtures.js"

const composerPlaceholder = /Message .+…/
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
