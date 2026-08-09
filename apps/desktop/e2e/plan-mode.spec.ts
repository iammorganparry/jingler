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

const session = (id = "s_enhanced_plan") =>
  ({ repoPath }: { repoPath: string }): ReadonlyArray<SeedSession> => [{
    id,
    repo: "widget",
    repoPath,
    branch: "main",
    title: "Enhanced plan workspace",
    status: "idle",
    cli: "claude",
    diff: { added: 0, removed: 0 },
    prNumber: null,
    costUsd: 0,
    tokens: 0,
    updatedAt: "2026-07-28T00:00:00.000Z",
    worktreePath: repoPath,
    workspaceMode: "direct",
    mode: "accept-edits"
  }]

const currentPlanPath = (launched: LaunchedApp): string =>
  join(planDirectory(launched.home, launched.repoPath), "current-plan.json")

const readPlan = (launched: LaunchedApp) =>
  JSON.parse(readFileSync(currentPlanPath(launched), "utf8"))

const proposePlan = async (launched: LaunchedApp, prompt = "[[plan]] refactor auth to a TokenStore") => {
  const composer = launched.window.getByPlaceholder(/Message .+…/)
  await composer.fill(prompt)
  await composer.press("Enter")
  await expect.poll(() => existsSync(currentPlanPath(launched)), { timeout: 20_000 }).toBe(true)
  await launched.window.getByRole("button", { name: "Plan Review" }).first().click()
  await expect(
    launched.window.locator('[data-step-id="s_01"]').getByText("Audit session middleware", { exact: true })
  ).toBeVisible({ timeout: 20_000 })
}

const approvePlan = async (launched: LaunchedApp) => {
  await launched.window.getByRole("button", { name: "More plan actions" }).click()
  await launched.window.getByRole("menuitem", { name: "Approve and auto", exact: true }).click()
}

test("approving executes the plan in the producing agent and records task progress", async ({
  launchApp
}) => {
  const launched = await launchApp({
    configured: true,
    withRepo: true,
    sessions: session()
  })
  await expect(appShell(launched.window)).toBeVisible()
  await proposePlan(launched)
  await approvePlan(launched)

  await expect(launched.window.getByRole("button", { name: "Plan completed" })).toBeVisible({
    timeout: 30_000
  })
  await expect.poll(() => readPlan(launched).status).toBe("done")
  await expect.poll(() =>
    readPlan(launched).plan.stages.flatMap(
      (stage: { tasks: ReadonlyArray<{ status: string }> }) => stage.tasks.map((task) => task.status)
    )
  ).not.toContain("pending")
  await launched.window.getByTestId("active-chat-tab").first().click()
  await expect(launched.window.getByText("Steps 2, 3 and 5 are done.")).toBeVisible()
  await expect(launched.window.getByText(/PLAN_TASK|PLAN_RESULT/)).toHaveCount(0)
})

test("the producing agent amends an approved plan in place without regressing completed tasks", async ({
  launchApp
}) => {
  const launched = await launchApp({
    configured: true,
    withRepo: true,
    sessions: session("s_amended_plan")
  })
  await expect(appShell(launched.window)).toBeVisible()
  await proposePlan(
    launched,
    "[[plan]] [[plan-needs-verification]] refactor auth to a TokenStore"
  )
  await approvePlan(launched)
  await expect.poll(() => readPlan(launched).status, { timeout: 30_000 }).toBe("needs-verification")

  const completedBefore = readPlan(launched).plan.stages.flatMap(
    (stage: { tasks: ReadonlyArray<{ id: string; status: string }> }) =>
      stage.tasks.filter((task) => task.status === "completed").map((task) => task.id)
  )
  const revisionBefore = readPlan(launched).revision

  await launched.window.getByTestId("active-chat-tab").first().click()
  const composer = launched.window.getByPlaceholder(/Message .+…/)
  await composer.fill("[[amendment]] Add an explicit auth audit stage.")
  await composer.press("Enter")

  await expect.poll(() => readPlan(launched).revision, { timeout: 20_000 }).toBeGreaterThan(revisionBefore)
  await expect.poll(() => readPlan(launched).plan.stages.some(
    (stage: { id: string }) => stage.id === "s_07"
  )).toBe(true)
  const completedAfter = readPlan(launched).plan.stages.flatMap(
    (stage: { tasks: ReadonlyArray<{ id: string; status: string }> }) =>
      stage.tasks.filter((task) => task.status === "completed").map((task) => task.id)
  )
  expect(completedAfter).toEqual(expect.arrayContaining(completedBefore))
  await expect(launched.window.getByRole("button", { name: /Approve & implement/ })).toHaveCount(0)
})

test("Jingler tools replace provider-native plan mode with enhanced Plan", async ({ launchApp }) => {
  const launched = await launchApp({
    configured: true,
    withRepo: true,
    sessions: session("s_enhanced_label"),
    config: {
      openConnector: {
        endpoint: "",
        enabled: false,
        serverName: "open-connector",
        preferJinglerTools: true
      }
    }
  })
  await expect(appShell(launched.window)).toBeVisible()
  const composer = launched.window.getByPlaceholder(/Message .+…/)
  await composer.click()
  await launched.window.keyboard.press("Shift+Tab")
  await launched.window.keyboard.press("Shift+Tab")
  await expect(launched.window.locator("[data-mode='plan']")).toContainText("Enhanced Plan")
})

test("disabling Jingler tools restores the selected provider native plan mode", async ({ launchApp }) => {
  const launched = await launchApp({
    configured: true,
    withRepo: true,
    sessions: session("s_native_label"),
    config: {
      openConnector: {
        endpoint: "",
        enabled: false,
        serverName: "open-connector",
        preferJinglerTools: false
      }
    }
  })
  await expect(appShell(launched.window)).toBeVisible()
  const composer = launched.window.getByPlaceholder(/Message .+…/)
  await composer.click()
  await launched.window.keyboard.press("Shift+Tab")
  await launched.window.keyboard.press("Shift+Tab")
  const surface = launched.window.locator("[data-mode='plan']")
  await expect(surface).toContainText("Plan")
  await expect(surface).not.toContainText("Enhanced Plan")

  await composer.fill("[[storm]] Use the provider-native planning flow.")
  await composer.press("Enter")
  await expect(launched.window.getByText("Scanned four files.")).toBeVisible()
  expect(existsSync(currentPlanPath(launched))).toBe(false)
})

test("restart preserves completed tasks in a partially executed plan", async ({ launchApp }) => {
  const first = await launchApp({
    configured: true,
    withRepo: true,
    sessions: session("s_restart_progress")
  })
  await expect(appShell(first.window)).toBeVisible()
  await proposePlan(first, "[[plan]] [[plan-partial-hold]] refactor auth to a TokenStore")
  await approvePlan(first)
  await expect.poll(() => {
    const stage = readPlan(first).plan.stages.find((candidate: { id: string }) => candidate.id === "s_02")
    return stage?.tasks.map((task: { status: string }) => task.status)
  }, { timeout: 20_000 }).toEqual(["completed", "completed"])
  await first.app.close()

  const reopened = await launchApp({
    home: first.home,
    reposDir: first.reposDir,
    userDataDir: first.userDataDir,
    configured: true,
    withRepo: true
  })
  await expect(appShell(reopened.window)).toBeVisible()
  await reopened.window.getByRole("button", { name: "Plan Review" }).first().click()
  const stage = reopened.window.locator('[data-step-id="s_02"]')
  await expect(stage.getByText("2 of 2 completed", { exact: true })).toBeVisible()
})
