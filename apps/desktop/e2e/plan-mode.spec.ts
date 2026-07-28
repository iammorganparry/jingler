import { readFileSync, writeFileSync } from "node:fs"
import { basename, join } from "node:path"
import { DEFAULT_PLAN_TEMPLATE } from "@jingler/core"
import type { Page } from "@playwright/test"
import {
  appShell,
  expect,
  type LaunchedApp,
  type SeedSession,
  test
} from "./fixtures.js"

const session = (
  cli: SeedSession["cli"] = "claude",
  id = `s_plan_${cli}`
) =>
  ({ repoPath }: { repoPath: string }): ReadonlyArray<SeedSession> => [{
    id,
    repo: "widget",
    branch: `jingler/${id}`,
    title: `${cli} plan`,
    status: "idle",
    cli,
    diff: { added: 0, removed: 0 },
    prNumber: null,
    costUsd: 0,
    tokens: 0,
    updatedAt: "2026-07-28T00:00:00.000Z",
    worktreePath: repoPath,
    mode: "accept-edits"
  }]

const currentPlanPath = (launched: LaunchedApp): string =>
  join(
    launched.home,
    "jingler",
    ".jingler",
    basename(launched.repoPath),
    "current-plan.mdx"
  )

const openSettings = async (window: Page): Promise<void> => {
  await window.getByRole("button", { name: "Account menu" }).click()
  await window.getByRole("menuitem", { name: "Settings" }).click()
  await expect(window.getByRole("button", { name: "Close settings" })).toBeVisible()
}

const proposePlan = async (window: Page): Promise<void> => {
  const composer = window.getByPlaceholder(/Message .+…/)
  await composer.fill("[[plan]] refactor auth to a TokenStore")
  await composer.press("Enter")
  const review = window.getByRole("button", { name: "Plan Review" }).first()
  await expect(review).toBeVisible({ timeout: 20_000 })
  await review.click()
  await expect(window.getByRole("status")).toContainText("Synced", {
    timeout: 20_000
  })
}

const editSource = async (
  window: Page,
  change: (source: string) => string
): Promise<string> => {
  await window.getByRole("tab", { name: "Source" }).click()
  const source = window.getByLabel("Plan MDX source")
  const edited = change(await source.inputValue())
  await source.fill(edited)
  await expect(window.getByRole("status")).toContainText(/Editing|Saving/)
  await expect(window.getByRole("status")).toContainText("Synced", {
    timeout: 20_000
  })
  return edited
}

test("the PRD template validates, persists, and resets", async ({ launchApp }) => {
  const first = await launchApp({
    configured: true,
    withRepo: true,
    sessions: session()
  })
  await expect(appShell(first.window)).toBeVisible()
  await openSettings(first.window)
  await first.window.getByRole("button", { name: "Plan", exact: true }).click()

  const source = first.window.getByLabel("Plan template source")
  const customised = DEFAULT_PLAN_TEMPLATE.replace(
    "## Risks",
    "## Constraints and risks"
  )
  await source.fill(`${customised}\n\n{executePlan()}`)
  await expect(first.window.getByRole("alert")).toContainText(
    "JavaScript expressions are not allowed"
  )
  await expect(first.window.getByRole("button", { name: "Save template" })).toBeDisabled()

  await source.fill(customised)
  await expect(
    first.window.getByText("Constraints and risks", { exact: true })
  ).toBeVisible()
  await first.window.getByRole("button", { name: "Save template" }).click()
  await expect(first.window.getByRole("button", { name: "Save template" })).toBeDisabled()
  await first.app.close()

  const reopened = await launchApp({
    home: first.home,
    reposDir: first.reposDir,
    userDataDir: first.userDataDir,
    configured: true,
    withRepo: true
  })
  await openSettings(reopened.window)
  await reopened.window.getByRole("button", { name: "Plan", exact: true }).click()
  await expect(reopened.window.getByLabel("Plan template source")).toHaveValue(
    /Constraints and risks/
  )

  await reopened.window.getByRole("button", { name: "Reset default" }).click()
  await reopened.window.getByRole("button", { name: "Save template" }).click()
  await expect(reopened.window.getByLabel("Plan template source")).not.toHaveValue(
    /Constraints and risks/
  )
})

test("live source, annotations, and conflicts preserve both drafts", async ({
  launchApp
}) => {
  const launched = await launchApp({
    configured: true,
    withRepo: true,
    sessions: session()
  })
  await expect(appShell(launched.window)).toBeVisible()
  await proposePlan(launched.window)

  const operatorText = "Operator-authored rollout guard"
  await editSource(launched.window, (source) =>
    source.replace("Implement stages in order", `${operatorText}. Implement stages in order`)
  )
  await expect.poll(
    () => readFileSync(currentPlanPath(launched), "utf8")
  ).toContain(operatorText)

  await launched.window.getByRole("tab", { name: "Rendered" }).click()
  const stage = launched.window
    .getByRole("article")
    .filter({ hasText: "Audit session middleware" })
  await stage
    .getByPlaceholder("Add an instruction, concern, or decision for the agent…")
    .fill("Keep the operator note attached to this stage.")
  await stage.getByRole("button", { name: "Annotate" }).click()
  await expect(
    launched.window.getByText("Keep the operator note attached to this stage.")
  ).toBeVisible()
  await expect(launched.window.getByRole("status")).toContainText("Synced", {
    timeout: 20_000
  })

  await launched.window.getByRole("tab", { name: "Source" }).click()
  const source = launched.window.getByLabel("Plan MDX source")
  await source.fill(`${await source.inputValue()}\n\n<!-- local draft survives -->\n`)

  const file = currentPlanPath(launched)
  const persisted = readFileSync(file, "utf8")
  const revision = Number(/^revision:\s*(\d+)$/m.exec(persisted)?.[1] ?? 0)
  const remote = persisted
    .replace(/^revision:\s*\d+$/m, `revision: ${revision + 1}`)
    .replace(
      "Imported from a legacy native plan artifact.",
      "Remote revision preserved beside the local draft."
    )
  writeFileSync(file, remote)

  await expect(launched.window.getByRole("status")).toContainText("Conflict", {
    timeout: 20_000
  })
  await expect(
    launched.window.getByText("Local draft", { exact: true })
  ).toBeVisible()
  await expect(
    launched.window.getByText(`Remote revision ${revision + 1}`, { exact: true })
  ).toBeVisible()
  await launched.window.getByRole("button", { name: "Keep local and save" }).click()
  await expect(launched.window.getByRole("status")).toContainText("Synced", {
    timeout: 20_000
  })
  await expect.poll(() => readFileSync(file, "utf8")).toContain(
    "local draft survives"
  )
})

test("approval executes the saved revision and finishes from criterion evidence", async ({
  launchApp
}) => {
  const launched = await launchApp({
    configured: true,
    withRepo: true,
    sessions: session()
  })
  await expect(appShell(launched.window)).toBeVisible()
  await proposePlan(launched.window)

  const exactText = "The exact operator-approved revision"
  await editSource(launched.window, (source) =>
    source.replace("The operator reviews", `${exactText}. The operator reviews`)
  )
  await launched.window.getByRole("button", {
    name: "Approve and auto",
    exact: true
  }).click()

  await expect(launched.window.getByText("All criteria verified")).toBeVisible({
    timeout: 30_000
  })
  await expect(launched.window.getByText(exactText)).toBeVisible()
  const persisted = readFileSync(currentPlanPath(launched), "utf8")
  expect(persisted).toContain('status: "done"')
  expect(persisted).toContain(exactText)
  expect(persisted).toContain('status="passed"')
})

test("restart resumes the exact canonical revision", async ({ launchApp }) => {
  const first = await launchApp({
    configured: true,
    withRepo: true,
    sessions: session()
  })
  await expect(appShell(first.window)).toBeVisible()
  await proposePlan(first.window)

  const exactText = "Restart-safe operator criterion"
  await editSource(first.window, (source) =>
    source.replace("Each stage records", `${exactText}. Each stage records`)
  )
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
  await expect(reopened.window.getByText("stale", { exact: true })).toBeVisible()
  await expect(reopened.window.getByText(exactText).last()).toBeVisible()
  await reopened.window.getByRole("button", { name: "Approve & implement" }).click()
  await reopened.window.getByRole("button", { name: "Conversation" }).first().click()
  expect(readFileSync(currentPlanPath(reopened), "utf8")).toContain(exactText)
  await reopened.window.getByRole("button", { name: /Allow once/ }).click()
  await reopened.window.getByRole("button", { name: "Plan Review" }).first().click()
  await expect(reopened.window.getByText("needs verification", { exact: true })).toBeVisible({
    timeout: 30_000
  })
})

test("Claude, Codex, and opencode share native plan mode", async ({ launchApp }) => {
  for (const cli of ["claude", "codex", "opencode"] as const) {
    const launched = await launchApp({
      configured: true,
      withRepo: true,
      sessions: session(cli),
      ...(cli === "opencode" ? { opencode: { providers: [] } } : {})
    })
    await expect(appShell(launched.window)).toBeVisible()
    const composer = launched.window.getByPlaceholder(/Message .+…/)
    await composer.click()
    await launched.window.keyboard.press("Shift+Tab")
    await launched.window.keyboard.press("Shift+Tab")
    await expect(launched.window.locator("[data-mode='plan']")).toBeVisible()
    await composer.fill(`Plan this change with ${cli}.`)
    await composer.press("Enter")
    await expect(
      launched.window.getByRole("button", { name: "Plan Review" }).first()
    ).toBeVisible({ timeout: 20_000 })
    expect(readFileSync(currentPlanPath(launched), "utf8")).toContain("jinglerPlan: 1")
    await launched.app.close()
  }
})
