import { existsSync, rmSync, writeFileSync } from "node:fs"
import { createServer } from "node:net"
import { join } from "node:path"
import type { ElectronApplication } from "@playwright/test"
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

const reviewScript = (app: ElectronApplication, expression: string) =>
  app.evaluate(async ({ webContents }, source) => {
    const page = webContents.getAllWebContents().find((contents) =>
      contents.getURL().startsWith("http://localhost:")
    )
    return page?.executeJavaScript(source) ?? null
  }, expression)

const reviewUrls = (app: ElectronApplication) =>
  app.evaluate(async ({ webContents }) =>
    webContents.getAllWebContents()
      .map((contents) => contents.getURL())
      .filter((url) => url.startsWith("http://localhost:"))
  )

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
  const hostBackground = await launched.window.evaluate(() =>
    getComputedStyle(document.documentElement).getPropertyValue("--sb-canvas").trim()
  )
  const reviewBackground = await reviewScript(
    launched.app,
    "getComputedStyle(document.documentElement).getPropertyValue('--background').trim()"
  )
  expect(reviewBackground).toBe(hostBackground)

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
    launched.window.getByText("Implemented and verified the approved plan.").first()
  ).toBeVisible({ timeout: 30_000 })
  await expect(launched.window.locator("[data-mode='auto']")).toContainText("Auto")
  await expect(launched.window.getByRole("button", { name: "Plan Review" })).toHaveCount(0)
  await expect(launched.window.getByText("2/2")).toBeVisible({ timeout: 20_000 })
  await expect.poll(async () =>
    (await reviewPages()).filter(({ url }) => url.startsWith("http://localhost:")).length,
  { timeout: 20_000 }).toBe(0)
})

test("Plannotator feedback revises the same plan before approval", async ({ launchApp }) => {
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
  await composer.fill("[[plan]] replace auth")
  await composer.press("Enter")
  const planTab = launched.window.getByRole("button", { name: "Plan Review" }).first()
  await expect(planTab).toBeVisible({ timeout: 20_000 })
  await planTab.click()
  await expect.poll(() => reviewScript(launched.app, "document.body?.innerText ?? ''"), {
    timeout: 20_000
  }).toContain("Continue")
  await reviewScript(
    launched.app,
    `[...document.querySelectorAll('button')].find((button) => button.textContent?.trim() === 'Continue')?.click()`
  )
  await expect.poll(() => reviewScript(
    launched.app,
    `Boolean(document.querySelector('button[title="Add global comment"]'))`
  )).toBe(true)
  await reviewScript(launched.app, `document.querySelector('button[title="Add global comment"]')?.click()`)
  await expect.poll(() => reviewScript(
    launched.app,
    `Boolean(document.querySelector('textarea[placeholder="Add a global comment..."]'))`
  )).toBe(true)
  await reviewScript(launched.app, `(() => {
    const node = document.querySelector('textarea[placeholder="Add a global comment..."]');
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
    setter?.call(node, 'Keep the existing token format.');
    node?.dispatchEvent(new Event('input', { bubbles: true }));
  })()`)
  await expect.poll(() => reviewScript(
    launched.app,
    `[...document.querySelectorAll('button')].find((button) => button.textContent?.trim() === 'Add')?.disabled`
  )).toBe(false)
  await reviewScript(
    launched.app,
    `[...document.querySelectorAll('button')].find((button) => button.textContent?.trim() === 'Add')?.click()`
  )
  await expect.poll(() => reviewScript(
    launched.app,
    `document.querySelector('button[title="Send Feedback"]')?.disabled`
  )).toBe(false)
  await reviewScript(launched.app, `document.querySelector('button[title="Send Feedback"]')?.click()`)
  await expect.poll(() => reviewScript(launched.app, "document.body?.innerText ?? ''"), {
    timeout: 30_000
  }).toContain("keeping the existing token format")

  await reviewScript(launched.app, `(() => {
    const button = [...document.querySelectorAll('button')].find(
      (candidate) => candidate.textContent?.includes('Approve')
    );
    button?.click();
  })()`)
  await launched.window.getByTestId("active-chat-tab").first().click()
  await expect(launched.window.getByText("Implemented and verified the approved plan.").first())
    .toBeVisible({ timeout: 30_000 })
  await expect(launched.window.getByText("2/2")).toBeVisible({ timeout: 20_000 })
})

test("a pending Plannotator review reopens after an Electron restart", async ({ launchApp }) => {
  const first = await launchApp({
    configured: true,
    withRepo: true,
    piFixture: PI_FIXTURE,
    sessions
  })
  await expect(appShell(first.window)).toBeVisible()

  const composer = first.window.getByPlaceholder(/Message .+…/)
  await composer.click()
  await first.window.keyboard.press("Shift+Tab")
  await first.window.keyboard.press("Shift+Tab")
  await composer.fill("[[plan]] replace auth")
  await composer.press("Enter")
  await expect(first.window.getByRole("button", { name: "Plan Review" }).first())
    .toBeVisible({ timeout: 20_000 })
  await first.app.close()

  const reopened = await launchApp({
    configured: true,
    withRepo: true,
    home: first.home,
    reposDir: first.reposDir,
    userDataDir: first.userDataDir,
    authServer: first.authServer,
    githubServer: first.githubServer,
    githubRelay: first.githubRelay
  })
  await expect(appShell(reopened.window)).toBeVisible()
  const planTab = reopened.window.getByRole("button", { name: "Plan Review" }).first()
  await expect(planTab).toBeVisible({ timeout: 20_000 })
  await planTab.click()
  await expect.poll(() => reopened.app.evaluate(async ({ webContents }) => {
    const page = webContents.getAllWebContents().find((contents) =>
      contents.getURL().startsWith("http://localhost:")
    )
    return page?.executeJavaScript("document.body?.innerText ?? ''") ?? ""
  }), { timeout: 30_000 }).toContain("Implement the auth change")
  const [reviewUrl] = await reviewUrls(reopened.app)
  expect(reviewUrl).toMatch(/^http:\/\/localhost:/)
  await reopened.window.getByTestId("active-chat-tab").first().click()
  await expect(reopened.window.getByText("0/2")).toBeVisible({ timeout: 20_000 })
  const transcriptCard = reopened.window.getByTestId("plannotator-transcript-card")
  await expect(transcriptCard).toContainText("Implement the auth change")
  await expect(transcriptCard).toContainText("Verify the auth change")
  await expect(transcriptCard.getByRole("button", { name: /^Approve$/ })).toHaveCount(0)
  const planDrawer = reopened.window.getByTestId("plan-task-list")
  await expect(planDrawer).toContainText("Implement the auth change")
  await expect(planDrawer).toContainText("Verify the auth change")

  await planTab.click()
  await expect.poll(() => reviewUrls(reopened.app)).toEqual([reviewUrl])
})

for (const recoveryCase of [
  {
    name: "missing",
    prepare: (path: string) => rmSync(path),
    message: "Cannot resume plan review: PLAN.md no longer exists."
  },
  {
    name: "empty",
    prepare: (path: string) => writeFileSync(path, ""),
    message: "Cannot resume plan review: PLAN.md is empty."
  }
]) {
  test(`pending review fails closed when PLAN.md is ${recoveryCase.name}`, async ({ launchApp }) => {
    const first = await launchApp({
      configured: true,
      withRepo: true,
      piFixture: PI_FIXTURE,
      sessions
    })
    await expect(appShell(first.window)).toBeVisible()

    const composer = first.window.getByPlaceholder(/Message .+…/)
    await composer.click()
    await first.window.keyboard.press("Shift+Tab")
    await first.window.keyboard.press("Shift+Tab")
    await composer.fill("[[plan]] replace auth")
    await composer.press("Enter")
    await expect(first.window.getByRole("button", { name: "Plan Review" }).first())
      .toBeVisible({ timeout: 20_000 })
    await first.app.close()

    recoveryCase.prepare(join(first.repoPath, "PLAN.md"))
    const reopened = await launchApp({
      configured: true,
      withRepo: true,
      home: first.home,
      reposDir: first.reposDir,
      userDataDir: first.userDataDir,
      authServer: first.authServer,
      githubServer: first.githubServer,
      githubRelay: first.githubRelay
    })
    await expect(appShell(reopened.window)).toBeVisible()
    await expect(reopened.window.getByText(recoveryCase.message)).toBeVisible({ timeout: 20_000 })
    await expect(reopened.window.getByText("Implemented and verified the approved plan."))
      .toHaveCount(0)
    await expect(reopened.window.getByRole("button", { name: "Plan Review" })).toHaveCount(0)
    await expect(reopened.window.getByTestId("plan-task-list")).toHaveCount(0)
    await expect.poll(() => reviewUrls(reopened.app)).toEqual([])
  })
}

test("review startup failure stays unapproved and does not loop after restart", async ({
  launchApp
}) => {
  const blocker = createServer()
  await new Promise<void>((resolve, reject) => {
    blocker.once("error", reject)
    blocker.listen(0, "127.0.0.1", resolve)
  })
  const address = blocker.address()
  if (address === null || typeof address === "string") {
    throw new Error("Expected a bound TCP port")
  }
  const e2eEnv = { PLANNOTATOR_PORT: String(address.port) }

  try {
    const first = await launchApp({
      configured: true,
      withRepo: true,
      piFixture: PI_FIXTURE,
      sessions,
      e2eEnv
    })
    await expect(appShell(first.window)).toBeVisible()

    const composer = first.window.getByPlaceholder(/Message .+…/)
    await composer.click()
    await first.window.keyboard.press("Shift+Tab")
    await first.window.keyboard.press("Shift+Tab")
    await composer.fill("[[plan]] replace auth")
    await composer.press("Enter")
    await expect(first.window.getByText(/Failed to start plan review UI:/))
      .toBeVisible({ timeout: 20_000 })
    await expect(first.window.getByText("Implemented and verified the approved plan."))
      .toHaveCount(0)
    await expect.poll(() => reviewUrls(first.app)).toEqual([])
    await first.app.close()

    const reopened = await launchApp({
      configured: true,
      withRepo: true,
      home: first.home,
      reposDir: first.reposDir,
      userDataDir: first.userDataDir,
      authServer: first.authServer,
      githubServer: first.githubServer,
      githubRelay: first.githubRelay,
      e2eEnv
    })
    await expect(appShell(reopened.window)).toBeVisible()
    await expect(reopened.window.getByRole("button", { name: "Plan Review" })).toHaveCount(0)
    await expect(reopened.window.getByText("Implemented and verified the approved plan."))
      .toHaveCount(0)
    await expect.poll(() => reviewUrls(reopened.app)).toEqual([])
  } finally {
    await new Promise<void>((resolve) => blocker.close(() => resolve()))
  }
})
