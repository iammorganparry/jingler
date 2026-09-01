import { existsSync } from "node:fs"
import { join } from "node:path"
import { appShell, expect, type SeedSession, test } from "./fixtures.js"

// The enhanced-plan scratchpad flow on Plannotator: a normal session where the
// agent keeps a STRUCTURED markdown plan (stages, tasks, acceptance, files,
// complexity), adopts it silently, and ticks progress while it works. The Plan
// tab persists as the plan's home — stages render natively, and the composer
// drawer mirrors the same live checklist.
const PI_FIXTURE = {
  scenarioId: "rich-plan-scratchpad",
  authRoute: "api-key" as const
}

const COMPOSER_PLACEHOLDER = /Message .+…/

const sessions = ({ repoPath }: { repoPath: string }): ReadonlyArray<SeedSession> => [{
  id: "s_rich_scratchpad",
  repo: "widget",
  repoPath,
  branch: "main",
  title: "Rich scratchpad workspace",
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
    id: "s_rich_scratchpad_chat",
    title: null,
    createdAt: "2026-08-27T00:00:00.000Z",
    updatedAt: "2026-08-27T00:00:00.000Z",
    mode: "accept-edits",
    connectionId: "jingler-e2e-connection",
    providerId: "jingler-e2e",
    modelId: "jingler-e2e/eval-model"
  }],
  activeChatId: "s_rich_scratchpad_chat"
}]

test("a structured plan renders stages natively and ticks live progress", async ({
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
  await composer.fill("keep a structured plan while you work")
  await composer.press("Enter")

  await expect.poll(() => existsSync(join(launched.repoPath, "PLAN.md")), {
    timeout: 20_000
  }).toBe(true)

  // The Plan tab appears from plan existence alone — no review, no plan mode.
  const planTab = launched.window.getByTestId("view-tab-plan").first()
  await expect(planTab).toBeVisible({ timeout: 20_000 })
  await planTab.click()

  // The native document renders the parsed structure: frontmatter title and
  // both stages, not a flat checklist.
  await expect(
    launched.window.getByText("Token store rollout").first()
  ).toBeVisible({ timeout: 20_000 })
  await expect(launched.window.getByText("Token store", { exact: true }).first()).toBeVisible()
  await expect(launched.window.getByText("Rollout", { exact: true }).first()).toBeVisible()
  await expect(
    launched.window.getByText("Build the store behind the existing interface.").first()
  ).toBeVisible()

  await expect(
    launched.window.getByText("Implement TokenStore").first()
  ).toBeVisible()

  // [DONE:1] ticked the first task, so the first stage is running (not done):
  // the drawer badge counts completed STAGES over total stages.
  await launched.window.getByTestId("active-chat-tab").first().click()
  await expect(
    launched.window.getByRole("tab", { name: /Plan/ }).first()
  ).toContainText("0/2", { timeout: 20_000 })

  // Session state never changed: accept-edits, no review pending.
  await expect(launched.window.locator("[data-mode='accept-edits']")).toBeVisible()
})
