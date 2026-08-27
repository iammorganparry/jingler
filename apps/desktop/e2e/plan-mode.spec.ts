import { existsSync } from "node:fs"
import { join } from "node:path"
import { appShell, expect, type SeedSession, test } from "./fixtures.js"

const PI_FIXTURE = {
  scenarioId: "plan-mode",
  authRoute: "api-key" as const
}

const sessions = ({ repoPath }: { repoPath: string }): ReadonlyArray<SeedSession> => [{
  id: "s_plannotator",
  repo: "widget",
  repoPath,
  branch: "main",
  title: "Plannotator workspace",
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
    id: "s_plannotator_chat",
    title: null,
    createdAt: "2026-08-27T00:00:00.000Z",
    updatedAt: "2026-08-27T00:00:00.000Z",
    mode: "accept-edits",
    connectionId: "jingler-e2e-connection",
    providerId: "jingler-e2e",
    modelId: "jingler-e2e/eval-model"
  }],
  activeChatId: "s_plannotator_chat"
}]

test("Plannotator reviews inside the Plan tab and drives native progress", async ({
  launchApp
}) => {
  const launched = await launchApp({
    configured: true,
    withRepo: true,
    piFixture: PI_FIXTURE,
    sessions
  })
  await expect(appShell(launched.window)).toBeVisible()

  const composer = launched.window.getByPlaceholder(/Message .+…/)
  await composer.click()
  await launched.window.keyboard.press("Shift+Tab")
  await launched.window.keyboard.press("Shift+Tab")
  await expect(launched.window.locator("[data-mode='plan']")).toContainText("Plan")
  await composer.fill("[[plan]] replace auth")
  await composer.press("Enter")

  await expect.poll(() => existsSync(join(launched.repoPath, "PLAN.md")), {
    timeout: 20_000
  }).toBe(true)
  const planTab = launched.window.getByRole("button", { name: "Plan Review" }).first()
  await expect(planTab).toBeVisible({ timeout: 20_000 })
  await planTab.click()

  const reviewPages = async () => launched.app.evaluate(async ({ webContents }) =>
    Promise.all(webContents.getAllWebContents().map(async (contents) => ({
      url: contents.getURL(),
      text: await contents.executeJavaScript("document.body?.innerText ?? ''"),
      preferences: contents.getLastWebPreferences()
    }))))
  await expect.poll(async () =>
    (await reviewPages()).filter(({ url }) => url.startsWith("http://localhost:")).length,
  { timeout: 20_000 }).toBe(1)

  const review = (await reviewPages()).find(({ url }) =>
    url.startsWith("http://localhost:")
  )!
  expect(review.url).toMatch(/^http:\/\/localhost:\d+/)
  expect(review.preferences).toMatchObject({
    sandbox: true,
    contextIsolation: true,
    nodeIntegration: false
  })

  await launched.app.evaluate(async ({ webContents }) => {
    const page = webContents.getAllWebContents().find((contents) =>
      contents.getURL().startsWith("http://localhost:")
    )
    await page?.executeJavaScript(`(() => {
      const button = [...document.querySelectorAll('button')].find(
        (candidate) => candidate.textContent?.trim() === 'Continue'
      );
      button?.click();
    })()`)
  })
  await launched.window.waitForTimeout(300)

  const approved = await launched.app.evaluate(async ({ webContents }) => {
    const page = webContents.getAllWebContents().find((contents) =>
      contents.getURL().startsWith("http://localhost:")
    )
    if (!page) return false
    return page.executeJavaScript(`(() => {
      const button = [...document.querySelectorAll('button')].find(
        (candidate) => candidate.textContent?.includes('Approve')
      );
      if (!button) return false;
      button.click();
      return true;
    })()`)
  })
  expect(approved).toBe(true)

  await launched.window.getByTestId("active-chat-tab").first().click()
  await expect(
    launched.window.getByText("Implemented and verified the approved plan.")
  ).toBeVisible({ timeout: 30_000 })
  await expect(launched.window.getByText("2/2")).toBeVisible({ timeout: 20_000 })
  await expect.poll(async () =>
    (await reviewPages()).filter(({ url }) => url.startsWith("http://localhost:")).length,
  { timeout: 20_000 }).toBe(0)
})
