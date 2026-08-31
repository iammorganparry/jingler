import { existsSync } from "node:fs"
import { join } from "node:path"
import { appShell, expect, type SeedSession, test } from "./fixtures.js"

// The Plannotator scratchpad outside plan mode: a normal accept-edits session
// where the model writes PLAN.md, adopts it with plannotator_update_plan (no
// review, no phase change), and ticks progress with a [DONE:1] marker. The
// composer's plan drawer must surface the live checklist without the session
// ever entering plan mode.
const COMPOSER_PLACEHOLDER = /Message .+…/
const PLAN_DRAWER_TAB = /Plan/

const PI_FIXTURE = {
  scenarioId: "plan-scratchpad",
  authRoute: "api-key" as const
}

const sessions = ({ repoPath }: { repoPath: string }): ReadonlyArray<SeedSession> => [{
  id: "s_scratchpad",
  repo: "widget",
  repoPath,
  branch: "main",
  title: "Scratchpad workspace",
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
    id: "s_scratchpad_chat",
    title: null,
    createdAt: "2026-08-27T00:00:00.000Z",
    updatedAt: "2026-08-27T00:00:00.000Z",
    mode: "accept-edits",
    connectionId: "jingler-e2e-connection",
    providerId: "jingler-e2e",
    modelId: "jingler-e2e/eval-model"
  }],
  activeChatId: "s_scratchpad_chat"
}]

test("plan scratchpad tracks progress in a normal session without plan mode", async ({
  launchApp
}) => {
  const launched = await launchApp({
    configured: true,
    withRepo: true,
    piFixture: PI_FIXTURE,
    sessions
  })
  await expect(appShell(launched.window)).toBeVisible()

  const composer = launched.window.getByPlaceholder(COMPOSER_PLACEHOLDER)
  await composer.click()
  await expect(launched.window.locator("[data-mode='accept-edits']")).toBeVisible()
  await composer.fill("keep a plan while you work")
  await composer.press("Enter")

  // The scripted model writes the plan file and adopts it via
  // plannotator_update_plan — never via plan mode or a review.
  await expect.poll(() => existsSync(join(launched.repoPath, "PLAN.md")), {
    timeout: 20_000
  }).toBe(true)

  // The composer drawer projects the adopted checklist live.
  const taskList = launched.window.getByTestId("plan-task-list")
  await expect(taskList).toBeVisible({ timeout: 20_000 })
  await expect(taskList).toContainText("Implement the auth change")
  await expect(taskList).toContainText("Verify the auth change")

  // The [DONE:1] marker in the final assistant message ticks step one.
  await expect(
    launched.window.getByRole("tab", { name: PLAN_DRAWER_TAB }).first()
  ).toContainText("1/2", { timeout: 20_000 })

  // The session never left accept-edits: no plan mode, no review surface.
  await expect(launched.window.locator("[data-mode='accept-edits']")).toBeVisible()
  await expect(
    launched.window.getByRole("button", { name: "Plan Review" })
  ).toHaveCount(0)
})
