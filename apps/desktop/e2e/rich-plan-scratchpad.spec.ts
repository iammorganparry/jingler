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
    isolateSystemHome: true,
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

  // Plan is available from plan existence alone — no review or plan mode required.
  const planTab = launched.window.getByTestId("editor-tab-view-plan").getByRole("tab").first()
  if (await planTab.count() === 0) {
    await launched.window.getByRole("button", { name: "New tab" }).click()
    await launched.window.getByTestId("new-tab-option-plan").click()
  }
  await expect(planTab).toBeVisible({ timeout: 20_000 })
  await planTab.click()
  await expect(launched.window.locator('[data-testid^="editor-tab-view-plan"]').first()).toBeVisible()

  // The native document renders the parsed structure: frontmatter title and
  // both stages, not a flat checklist.
  await expect(
    launched.window.getByText("Token store rollout").filter({ visible: true }).first()
  ).toBeVisible({ timeout: 20_000 })
  await expect(launched.window.getByText("Token store", { exact: true }).filter({ visible: true }).first()).toBeVisible()
  await expect(launched.window.getByText("Rollout", { exact: true }).filter({ visible: true }).first()).toBeVisible()
  await expect(
    launched.window.getByText("Build the store behind the existing interface.").filter({ visible: true }).first()
  ).toBeVisible()

  await expect(
    launched.window.getByText("Implement TokenStore").filter({ visible: true }).first()
  ).toBeVisible()
  // Plan stays in the content pane while the chat remains visible on the left.
  await expect(launched.window.getByTestId("editor-group")).toHaveCount(2)
  await expect(launched.window.getByText("Token store rollout").filter({ visible: true }).first()).toBeVisible()

  // [DONE:1] ticked the first task, so the first stage is running (not done):
  // the drawer badge counts completed STAGES over total stages.
  // Plan sits over the chat in the first group; bring the transcript forward.
  // The chat is auto-titled from its first prompt, so find its tab by kind.
  await launched.window.locator('[data-testid^="editor-tab-chat-"]').first().getByRole("tab").click()
  await expect(
    launched.window.getByTestId("composer").filter({ visible: true }).first().getByRole("tab", { name: /Plan/ })
  ).toContainText("0/2", { timeout: 20_000 })
  await expect(launched.window.getByRole("button", { name: "Token store In progress" })).toBeVisible()
  await expect(launched.window.getByText("[DONE:1]", { exact: false })).toHaveCount(0)

  // Session state never changed: accept-edits, no review pending.
  await expect(launched.window.locator("[data-mode='accept-edits']")).toBeVisible()

  await launched.app.close()
  const reopened = await launchApp({
    configured: true,
    isolateSystemHome: true,
    withRepo: true,
    home: launched.home,
    reposDir: launched.reposDir,
    userDataDir: launched.userDataDir,
    authServer: launched.authServer,
    githubServer: launched.githubServer,
    githubRelay: launched.githubRelay
  })
  await expect(appShell(reopened.window)).toBeVisible()
  await expect(reopened.window.getByText("Adopted the structured plan. TokenStore implemented.", { exact: false })).toBeVisible({ timeout: 20_000 })
  await expect(reopened.window.getByText("[DONE:1]", { exact: false })).toHaveCount(0)
})
