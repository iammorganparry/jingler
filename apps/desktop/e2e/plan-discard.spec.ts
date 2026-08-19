import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import {
  appShell,
  expect,
  planDirectory,
  type LaunchedApp,
  type SeedSession,
  test
} from "./fixtures.js"

const PI_FIXTURE = {
  scenarioId: "plan-mode",
  authRoute: "api-key" as const
}

const session = (id = "s_discard_plan") =>
  ({ repoPath }: { repoPath: string }): ReadonlyArray<SeedSession> => {
    const chatId = `${id}_chat`
    return [
      {
        id,
        repo: "widget",
        repoPath,
        branch: "main",
        title: "Discard plan workspace",
        status: "idle",
        connectionId: "jingler-e2e-connection",
        providerId: "jingler-e2e",
        modelId: "jingler-e2e/eval-model",
        diff: { added: 0, removed: 0 },
        prNumber: null,
        costUsd: 0,
        tokens: 0,
        updatedAt: "2026-07-28T00:00:00.000Z",
        worktreePath: repoPath,
        workspaceMode: "direct",
        chats: [
          {
            id: chatId,
            title: null,
            createdAt: "2026-07-28T00:00:00.000Z",
            updatedAt: "2026-07-28T00:00:00.000Z",
            mode: "accept-edits",
            connectionId: "jingler-e2e-connection",
            providerId: "jingler-e2e",
            modelId: "jingler-e2e/eval-model"
          }
        ],
        activeChatId: chatId
      }
    ]
  }

const composerPlaceholder = /Message .+…/

const currentPlanPath = (launched: LaunchedApp): string =>
  join(planDirectory(launched.home, launched.repoPath), "current-plan.json")

const readPlan = (launched: LaunchedApp) =>
  JSON.parse(readFileSync(currentPlanPath(launched), "utf8"))

/** Cycle permission modes until the composer sits in Enhanced Plan. */
const enterPlanMode = async (launched: LaunchedApp, attempts = 5): Promise<void> => {
  const mode = launched.window.locator("[data-mode='plan']")
  const inPlanMode =
    (await mode.count()) > 0 &&
    ((await mode.first().textContent())?.includes("Enhanced Plan") ?? false)
  if (inPlanMode) return
  if (attempts === 0) {
    await expect(mode).toContainText("Enhanced Plan")
    return
  }
  await launched.window.keyboard.press("Shift+Tab")
  return enterPlanMode(launched, attempts - 1)
}

const proposePlan = async (launched: LaunchedApp) => {
  const composer = launched.window.getByPlaceholder(composerPlaceholder)
  await composer.click()
  await enterPlanMode(launched)
  await composer.fill("[[plan]] refactor auth to a TokenStore")
  await composer.press("Enter")
  await expect.poll(() => existsSync(currentPlanPath(launched)), { timeout: 20_000 }).toBe(true)
  await launched.window.getByRole("button", { name: "Plan Review" }).first().click()
  await expect(
    launched.window.locator('[data-step-id="s_01"]').getByText("Audit session middleware", { exact: true })
  ).toBeVisible({ timeout: 20_000 })
}

test("discarding a completed plan clears the review and the next submission proposes fresh", async ({
  launchApp
}) => {
  const launched = await launchApp({
    configured: true,
    withRepo: true,
    piFixture: PI_FIXTURE,
    sessions: session()
  })
  await expect(appShell(launched.window)).toBeVisible()
  await proposePlan(launched)
  await launched.window.getByRole("button", { name: "More plan actions" }).click()
  await launched.window.getByRole("menuitem", { name: "Approve and auto", exact: true }).click()
  await expect(launched.window.getByRole("button", { name: "Plan completed" })).toBeVisible({
    timeout: 30_000
  })
  const completedPlanId = readPlan(launched).id

  // Discard arms on the first select and runs on the second; the dropdown
  // stays open in between so the confirm is one deliberate double-choice.
  await launched.window.getByRole("button", { name: "More plan actions" }).click()
  await launched.window.getByRole("menuitem", { name: "Discard plan", exact: true }).click()
  await launched.window
    .getByRole("menuitem", { name: "Click again to discard", exact: true })
    .click()

  // The canonical file is gone and the watch-null emission clears the review —
  // the completed plan must not survive as a stale surface.
  await expect.poll(() => existsSync(currentPlanPath(launched)), { timeout: 10_000 }).toBe(false)
  await expect(launched.window.getByRole("button", { name: "Plan completed" })).toHaveCount(0, {
    timeout: 10_000
  })

  // A new submission now proposes FRESH: new plan id, revision 1, back behind
  // the approval gate — never an amendment of the discarded document.
  await launched.window.getByTestId("active-chat-tab").first().click()
  await proposePlan(launched)
  const proposed = readPlan(launched)
  expect(proposed.id).not.toBe(completedPlanId)
  expect(proposed.revision).toBe(1)
  expect(proposed.status).toBe("proposed")
  await expect(
    launched.window.getByTestId("plan-floating-actions").getByRole("button", { name: "Approve" })
  ).toBeEnabled({ timeout: 10_000 })
})
