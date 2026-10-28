import { existsSync } from "node:fs"
import { join } from "node:path"
import { appShell, expect, type SeedSession, test } from "./fixtures.js"
import { openView } from "./views.js"

// The agent publishes an architecture figure to the Explanation view and adopts
// a plan carrying the same figure as an ```architecture fence. Both surfaces
// must draw the parts, mark the lit subject, and show detail on focus.
const PI_FIXTURE = {
  scenarioId: "architecture-figure",
  authRoute: "api-key" as const
}

const COMPOSER_PLACEHOLDER = /Message .+…/

const sessions = ({ repoPath }: { repoPath: string }): ReadonlyArray<SeedSession> => [{
  id: "s_architecture",
  repo: "widget",
  repoPath,
  branch: "main",
  title: "Architecture workspace",
  status: "idle",
  connectionId: "jingler-e2e-connection",
  providerId: "jingler-e2e",
  modelId: "jingler-e2e/eval-model",
  diff: { added: 0, removed: 0 },
  prNumber: null,
  costUsd: 0,
  tokens: 0,
  updatedAt: "2026-10-11T00:00:00.000Z",
  worktreePath: repoPath,
  workspaceMode: "direct",
  chats: [{
    id: "s_architecture_chat",
    title: null,
    createdAt: "2026-10-11T00:00:00.000Z",
    updatedAt: "2026-10-11T00:00:00.000Z",
    mode: "accept-edits",
    connectionId: "jingler-e2e-connection",
    providerId: "jingler-e2e",
    modelId: "jingler-e2e/eval-model"
  }],
  activeChatId: "s_architecture_chat"
}]

test("architecture figures render in the explanation and plan views", async ({ launchApp }) => {
  const launched = await launchApp({
    configured: true,
    isolateSystemHome: true,
    withRepo: true,
    piFixture: PI_FIXTURE,
    sessions
  })
  const { window } = launched
  await expect(appShell(window)).toBeVisible()

  const composer = window.getByPlaceholder(COMPOSER_PLACEHOLDER)
  await composer.click()
  await composer.fill("show me the checkout architecture")
  await composer.press("Enter")

  await expect(window.getByText("Architecture figure published.").first()).toBeVisible({ timeout: 20_000 })
  await expect.poll(() => existsSync(join(launched.repoPath, "PLAN.md"))).toBe(true)

  const checkFigure = async () => {
    // Plan blocks take projection ids, so match any figure rather than "checkout".
    const figure = window.locator("[data-architecture]").filter({ visible: true }).first()
    await expect(figure).toBeVisible({ timeout: 20_000 })
    await expect(figure.locator("[data-architecture-part]")).toHaveCount(2)
    await expect(figure.locator('[data-lit="true"]')).toHaveAttribute("data-architecture-part", "api")
    const readout = figure.locator("[data-architecture-readout]")
    await expect(readout).toContainText("Hono, 3 replicas")
    await figure.locator('[data-architecture-part="db"]').focus()
    await expect(readout).toContainText("primary + replica")
  }

  await openView(window, "explanation")
  await checkFigure()

  await openView(window, "plan")
  await checkFigure()
})
