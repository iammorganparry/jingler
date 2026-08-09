import { execFileSync } from "node:child_process"
import { existsSync, mkdirSync, readFileSync, realpathSync } from "node:fs"
import { join } from "node:path"
import type { Page } from "@playwright/test"
import {
  appShell,
  expect,
  planDirectory,
  sessionRow,
  type SeedSession,
  test
} from "./fixtures.js"

const makeProject = (home: string, name: string): string => {
  const projectPath = join(home, name)
  mkdirSync(projectPath, { recursive: true })
  execFileSync("git", ["init", "-b", "main"], { cwd: projectPath })
  execFileSync("git", ["config", "user.email", "e2e@example.com"], { cwd: projectPath })
  execFileSync("git", ["config", "user.name", "Jingler E2E"], { cwd: projectPath })
  execFileSync("git", ["commit", "--allow-empty", "-m", "initial"], { cwd: projectPath })
  return projectPath
}

const addProject = async (window: Page, projectPath: string) => {
  await window.getByRole("button", { name: "Add project" }).click()
  await expect(window.getByRole("heading", { name: "Add project" })).toBeVisible()
  await window.getByRole("button", { name: /Search for directory/ }).click()
  await window.getByRole("textbox", { name: "Project directory" }).fill(projectPath)
  await window.getByRole("button", { name: "Add project" }).click()
}

const createWorkspace = async (
  window: Page,
  input: { title: string; checkout: "Local checkout" | "New worktree"; task?: string }
) => {
  await window.getByTestId("new-workspace").click()
  await expect(window.getByRole("heading", { name: "New workspace" })).toBeVisible()
  await window.getByRole("combobox", { name: "Checkout" }).click()
  await window.getByRole("option", { name: input.checkout }).click()
  await window.getByRole("textbox", { name: "Workspace name" }).fill(input.title)
  if (input.task) await window.getByRole("textbox", { name: "First task" }).fill(input.task)
  await window.getByRole("button", { name: /Create (workspace|and start)/ }).click()
  await expect(sessionRow(window, input.title)).toBeVisible({ timeout: 20_000 })
}

test("adds an existing directory as a project without creating a workspace", async ({ launchApp }) => {
  const launched = await launchApp({ configured: true })
  const projectPath = makeProject(launched.home, "sample-project")
  await expect(appShell(launched.window)).toBeVisible()
  await addProject(launched.window, projectPath)

  await expect(launched.window.getByText("sample-project", { exact: true })).toBeVisible()
  const projects = JSON.parse(readFileSync(join(launched.home, "jingler", "projects.json"), "utf8"))
  expect(projects).toHaveLength(1)
  expect(projects[0]).toMatchObject({ name: "sample-project", path: projectPath })
  const sessionsFile = join(launched.home, "jingler", "sessions.json")
  expect(existsSync(sessionsFile) ? JSON.parse(readFileSync(sessionsFile, "utf8")) : []).toEqual([])
})

test("creates a direct workspace from a registered project", async ({ launchApp }) => {
  const launched = await launchApp({ configured: true })
  const projectPath = makeProject(launched.home, "direct-project")
  await expect(appShell(launched.window)).toBeVisible()
  await addProject(launched.window, projectPath)
  await createWorkspace(launched.window, {
    title: "Direct workspace",
    checkout: "Local checkout"
  })

  const persisted = JSON.parse(readFileSync(join(launched.home, "jingler", "sessions.json"), "utf8"))[0]
  const canonicalProjectPath = realpathSync(projectPath)
  expect(persisted).toMatchObject({
    title: "Direct workspace",
    repoPath: canonicalProjectPath,
    worktreePath: canonicalProjectPath,
    workspaceMode: "direct"
  })
  expect(persisted.projectId).toBeTruthy()
})

test("creates an isolated worktree workspace from a selected base branch", async ({ launchApp }) => {
  const launched = await launchApp({ configured: true })
  const projectPath = makeProject(launched.home, "isolated-project")
  await expect(appShell(launched.window)).toBeVisible()
  await addProject(launched.window, projectPath)
  await createWorkspace(launched.window, {
    title: "Isolated workspace",
    checkout: "New worktree"
  })

  const persisted = JSON.parse(readFileSync(join(launched.home, "jingler", "sessions.json"), "utf8"))[0]
  expect(persisted.workspaceMode).toBe("worktree")
  expect(persisted.baseBranch).toBe("main")
  expect(persisted.worktreePath).not.toBe(projectPath)
  expect(existsSync(persisted.worktreePath)).toBe(true)
})

test("migrates a legacy repository and session into the project workspace hierarchy", async ({
  launchApp
}) => {
  const legacy = ({ repoPath }: { repoPath: string }): ReadonlyArray<SeedSession> => [{
    id: "s_legacy_project",
    repo: "widget",
    repoPath,
    branch: "main",
    title: "Legacy workspace",
    status: "idle",
    cli: "opencode",
    diff: { added: 0, removed: 0 },
    prNumber: null,
    costUsd: 0,
    tokens: 0,
    updatedAt: "2026-07-28T00:00:00.000Z",
    worktreePath: repoPath,
    workspaceMode: "direct"
  }]
  const launched = await launchApp({
    configured: true,
    withRepo: true,
    sessions: legacy
  })
  await expect(appShell(launched.window)).toBeVisible()
  await expect(
    launched.window.getByTestId("project-list").getByText("widget", { exact: true })
  ).toBeVisible()
  await expect(sessionRow(launched.window, "Legacy workspace")).toBeVisible()

  await expect.poll(() => existsSync(join(launched.home, "jingler", "projects.json"))).toBe(true)
  const projects = JSON.parse(readFileSync(join(launched.home, "jingler", "projects.json"), "utf8"))
  expect(projects).toHaveLength(1)
  const migrated = JSON.parse(readFileSync(join(launched.home, "jingler", "sessions.json"), "utf8"))[0]
  expect(migrated.id).toBe("s_legacy_project")
  expect(migrated.worktreePath).toBe(launched.repoPath)
  expect(migrated.projectId).toBe(projects[0].id)
  expect(migrated.cli).toBe("codex")
})

test("adds a project creates a workspace selects capabilities and completes an enhanced plan", async ({
  launchApp
}) => {
  const launched = await launchApp({ configured: true })
  const projectPath = makeProject(launched.home, "journey-project")
  await expect(appShell(launched.window)).toBeVisible()
  await addProject(launched.window, projectPath)
  await createWorkspace(launched.window, {
    title: "Complete journey",
    checkout: "New worktree",
    task: "[[plan]] refactor auth to a TokenStore"
  })

  await expect(launched.window.getByRole("button", { name: /^Model:/ })).toBeVisible()
  await launched.window.getByPlaceholder(/Message .+…/).press("Enter")
  const sessions = JSON.parse(readFileSync(join(launched.home, "jingler", "sessions.json"), "utf8"))
  const worktreePath = sessions[0].worktreePath as string
  const planFile = join(planDirectory(launched.home, worktreePath), "current-plan.json")
  await expect.poll(() => existsSync(planFile), { timeout: 20_000 }).toBe(true)
  await launched.window.getByRole("button", { name: "Plan Review" }).first().click()
  await launched.window.getByRole("button", { name: "More plan actions" }).click()
  await launched.window.getByRole("menuitem", { name: "Approve and auto", exact: true }).click()
  await expect.poll(() => JSON.parse(readFileSync(planFile, "utf8")).status, {
    timeout: 30_000
  }).toBe("done")
})
