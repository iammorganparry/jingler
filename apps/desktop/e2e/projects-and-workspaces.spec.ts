import { execFileSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Page } from "@playwright/test"
import {
  appShell,
  expect,
  sessionRow,
  type SeedSession,
  test
} from "./fixtures.js"

const LOCAL_REPOSITORY = /^Local repository/

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
  await window.getByTestId("new-session").click()
  await expect(window.getByRole("heading", { name: "New session" })).toBeVisible()
  await window.getByTestId("new-session-view").getByRole("button", { name: "Add project" }).click()
  await expect(window.getByRole("heading", { name: "Add project" })).toBeVisible()
  await window.getByRole("option", { name: LOCAL_REPOSITORY }).click()
  const directorySearch = window.getByPlaceholder("Search folders or enter an absolute path…")
  await directorySearch.fill(projectPath)
  await directorySearch.press("Enter")
  await expect(window.getByText(projectPath, { exact: true })).toBeVisible()
  await window.getByRole("button", { name: "Choose current folder" }).click()
  await window.getByRole("dialog").getByRole("button", { name: "Add project" }).click()
}

const createWorkspace = async (
  window: Page,
  input: { checkout: "Local" | "Worktree"; task?: string; baseBranch?: string }
) => {
  if (!(await window.getByTestId("new-session-view").isVisible())) {
    await window.getByTestId("new-session").click()
  }
  await expect(window.getByRole("heading", { name: "New session" })).toBeVisible()
  if (input.baseBranch) {
    await window.getByRole("button", { name: "Base branch" }).click()
    await window.getByPlaceholder("Search branches…").fill(input.baseBranch)
    await window.getByRole("option", { name: new RegExp(input.baseBranch) }).click()
  }
  await window.getByRole("button", { name: "Checkout" }).click()
  await window.getByRole("option", { name: input.checkout }).click()
  if (input.task) {
    await window.getByPlaceholder(/Message the agent/).fill(input.task)
    await window.getByPlaceholder(/Message the agent/).press("Enter")
  } else {
    await window.getByRole("button", { name: "Create workspace" }).click()
  }
  await expect(window.locator("[data-testid^='session-row-']").first()).toBeVisible({ timeout: 20_000 })
}

test("adds an existing directory as a project without creating a workspace", async ({ launchApp }) => {
  const launched = await launchApp({ configured: true })
  const projectPath = makeProject(launched.home, "sample-project")
  await expect(appShell(launched.window)).toBeVisible()
  await addProject(launched.window, projectPath)

  await expect(launched.window.getByTestId("project-list")).toHaveCount(0)
  await expect(launched.window.getByTestId("new-session-view")).toBeVisible()
  await expect(launched.window.getByRole("dialog")).toHaveCount(0)
  await expect(launched.window.getByRole("button", { name: "Project", exact: true })).toContainText("sample-project")
  await expect(launched.window.getByTestId("composer")).toBeVisible()
  await launched.window.getByRole("button", { name: "Close new session" }).click()
  const projects = JSON.parse(readFileSync(join(launched.home, "jingler", "projects.json"), "utf8"))
  expect(projects).toHaveLength(1)
  expect(projects[0]).toMatchObject({ name: "sample-project", path: projectPath })
  const sessionsFile = join(launched.home, "jingler", "sessions.json")
  expect(existsSync(sessionsFile) ? JSON.parse(readFileSync(sessionsFile, "utf8")) : []).toEqual([])
})

test("only lists imported projects and restores a hidden legacy project when imported again", async ({ launchApp }) => {
  const launched = await launchApp({
    configured: true,
    withRepo: true,
    isolateSystemHome: true,
    seed: ({ home, reposDir, repoPath }) => {
      const hiddenPath = makeProject(reposDir, "unimported")
      makeProject(reposDir, "discovered-only")
      mkdirSync(join(home, "jingler"), { recursive: true })
      writeFileSync(join(home, "jingler", "projects.json"), JSON.stringify([
        { id: "imported-widget", name: "widget", path: repoPath, imported: true, availability: "available", createdAt: "2026-01-01", updatedAt: "2026-01-01" },
        { id: "legacy-hidden", name: "unimported", path: hiddenPath, availability: "available", createdAt: "2026-01-01", updatedAt: "2026-01-01" }
      ]))
    }
  })
  const projects = launched.window.getByRole("navigation", { name: "Projects" })
  await expect(appShell(launched.window)).toBeVisible()
  await expect(projects.getByRole("button", { name: "widget", exact: true })).toBeVisible()
  await expect(projects.getByRole("button", { name: "unimported", exact: true })).toHaveCount(0)
  await expect(projects.getByRole("button", { name: "discovered-only", exact: true })).toHaveCount(0)
  const hiddenPath = join(launched.reposDir, "unimported")
  await launched.app.evaluate(({ dialog }, selected) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [selected] })
  }, hiddenPath)
  await projects.getByRole("button", { name: "Add project" }).click()
  const dialog = launched.window.getByRole("dialog")
  await dialog.getByRole("option", { name: LOCAL_REPOSITORY }).click()
  await dialog.getByRole("button", { name: "Browse in Finder" }).click()
  await expect(dialog.getByRole("textbox", { name: "Project directory" })).toHaveValue(hiddenPath)
  await dialog.getByRole("button", { name: "Add project" }).click()
  await expect(projects.getByRole("button", { name: "unimported", exact: true })).toBeVisible()
  await expect(projects.getByRole("button", { name: "discovered-only", exact: true })).toHaveCount(0)
  expect(existsSync(join(hiddenPath, ".git"))).toBe(true)
})

test("Browse opens the native file browser and registers its selected repository", async ({ launchApp }) => {
  const launched = await launchApp({ configured: true })
  const projectPath = makeProject(launched.home, "native-browse-project")
  await launched.app.evaluate(({ dialog }, selected) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [selected] })
  }, projectPath)

  await launched.window.getByTestId("new-session").click()
  await launched.window.getByTestId("new-session-view").getByRole("button", { name: "Add project" }).click()
  await launched.window.getByRole("option", { name: LOCAL_REPOSITORY }).click()
  await launched.window.getByRole("button", { name: "Browse in Finder" }).click()
  await expect(launched.window.getByRole("textbox", { name: "Project directory" })).toHaveValue(projectPath)
  await launched.window.getByRole("dialog").getByRole("button", { name: "Add project" }).click()

  await expect(launched.window.getByRole("button", { name: "Project", exact: true })).toContainText("native-browse-project")
})

test("Clone from GitHub loads installation repositories and clones with GitHub credentials", async ({ launchApp }) => {
  const fixtureRoot = mkdtempSync(join(tmpdir(), "jingler-github-clone-e2e-"))
  try {
    const source = makeProject(fixtureRoot, "source")
    const origin = join(fixtureRoot, "widget.git")
    execFileSync("git", ["clone", "--bare", source, origin])
    const gitConfig = join(fixtureRoot, "gitconfig")
    writeFileSync(gitConfig, `[url "file://${origin}"]\n\tinsteadOf = https://github.com/acme/widget.git\n`)
    const launched = await launchApp({
      configured: true,
      githubApp: {
        connected: true,
        accountLogin: "acme",
        repositorySelection: "selected",
        selectedRepositories: [{ id: "301", fullName: "acme/widget" }]
      },
      e2eEnv: { GIT_CONFIG_GLOBAL: gitConfig }
    })
    const cloneParent = join(launched.home, "clones")
    mkdirSync(cloneParent, { recursive: true })
    await launched.app.evaluate(({ dialog }, selected) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [selected] })
    }, cloneParent)

    await launched.window.getByTestId("new-session").click()
    await launched.window.getByTestId("new-session-view").getByRole("button", { name: "Add project" }).click()
    await launched.window.getByRole("option", { name: /^Remote repository/ }).click()
    await launched.window.getByRole("option", { name: /widget.*acme on GitHub/i }).click()
    await expect(launched.window.getByText(join(cloneParent, "widget"))).toBeVisible()
    await launched.window.getByRole("button", { name: "Clone project" }).click()

    await expect(launched.window.getByRole("button", { name: "Project", exact: true })).toContainText("widget")
    expect(existsSync(join(cloneParent, "widget", ".git"))).toBe(true)
    expect(launched.githubServer.credentialRequests).toContainEqual({
      repository: "acme/widget",
      permissions: ["contents:read"]
    })
  } finally {
    rmSync(fixtureRoot, { recursive: true, force: true })
  }
})

test("creates a direct workspace from a registered project", async ({ launchApp }) => {
  const launched = await launchApp({ configured: true })
  const projectPath = makeProject(launched.home, "direct-project")
  await expect(appShell(launched.window)).toBeVisible()
  await addProject(launched.window, projectPath)
  await createWorkspace(launched.window, {
    checkout: "Local"
  })

  const persisted = JSON.parse(readFileSync(join(launched.home, "jingler", "sessions.json"), "utf8"))[0]
  const canonicalProjectPath = realpathSync(projectPath)
  expect(persisted).toMatchObject({
    title: expect.any(String),
    autoTitle: true,
    repoPath: canonicalProjectPath,
    worktreePath: canonicalProjectPath,
    workspaceMode: "direct"
  })
  expect(persisted.projectId).toBeTruthy()
})

test("creates an isolated worktree workspace from a selected base branch", async ({ launchApp }) => {
  const launched = await launchApp({ configured: true })
  const projectPath = makeProject(launched.home, "isolated-project")
  execFileSync("git", ["branch", "release/searchable"], { cwd: projectPath })
  await expect(appShell(launched.window)).toBeVisible()
  await addProject(launched.window, projectPath)
  await createWorkspace(launched.window, {
    checkout: "Worktree",
    baseBranch: "release/searchable"
  })

  const persisted = JSON.parse(readFileSync(join(launched.home, "jingler", "sessions.json"), "utf8"))[0]
  expect(persisted.workspaceMode).toBe("worktree")
  expect(persisted.baseBranch).toBe("release/searchable")
  expect(persisted.worktreePath).not.toBe(projectPath)
  expect(existsSync(persisted.worktreePath)).toBe(true)
})

test("migrates an existing repository and session into the project workspace hierarchy", async ({
  launchApp
}) => {
  const legacy = ({ repoPath }: { repoPath: string }): ReadonlyArray<SeedSession> => [{
    id: "s_legacy_project",
    repo: "widget",
    repoPath,
    branch: "main",
    title: "Legacy workspace",
    status: "idle",
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
  await expect(launched.window.getByTestId("project-list")).toHaveCount(0)
  await expect(sessionRow(launched.window, "Legacy workspace")).toBeVisible()

  await expect.poll(() => existsSync(join(launched.home, "jingler", "projects.json"))).toBe(true)
  const projects = JSON.parse(readFileSync(join(launched.home, "jingler", "projects.json"), "utf8"))
  expect(projects).toHaveLength(1)
  const migrated = JSON.parse(readFileSync(join(launched.home, "jingler", "sessions.json"), "utf8"))[0]
  expect(migrated.id).toBe("s_legacy_project")
  expect(migrated.worktreePath).toBe(launched.repoPath)
  expect(migrated.projectId).toBe(projects[0].id)
  expect(migrated.connectionId).toBe("jingler-e2e-connection")
})

test("adds a project creates a workspace selects capabilities and completes a Plannotator plan", async ({
  launchApp
}) => {
  const launched = await launchApp({
    configured: true,
    piFixture: { scenarioId: "plan-mode", authRoute: "api-key" }
  })
  const projectPath = makeProject(launched.home, "journey-project")
  await expect(appShell(launched.window)).toBeVisible()
  await addProject(launched.window, projectPath)
  await expect(
    launched.window.getByRole("button", { name: "Model: Deterministic pi model" })
  ).toBeVisible()
  await createWorkspace(launched.window, {
    checkout: "Worktree",
    task: "[[plan]] refactor auth to a TokenStore"
  })

  await expect.poll(() => {
    const persisted = JSON.parse(readFileSync(join(launched.home, "jingler", "sessions.json"), "utf8"))[0]
    return persisted.chats[0].modelId
  }).toBe("jingler-e2e/eval-model")

  await expect(launched.window.getByRole("button", { name: /^Model:/ })).toBeVisible()
  const sessions = JSON.parse(readFileSync(join(launched.home, "jingler", "sessions.json"), "utf8"))
  const worktreePath = sessions[0].worktreePath as string
  // Plannotator owns the plan as a markdown file in the worktree; the native
  // Plan tab reviews and approves it — there is no separate plan store.
  await expect.poll(() => existsSync(join(worktreePath, "PLAN.md")), { timeout: 20_000 }).toBe(true)
  await launched.window.getByTestId("view-tab-plan").first().click()
  await expect.poll(() => launched.app.evaluate(async ({ webContents }) => {
    const review = webContents.getAllWebContents()
      .find((contents) => contents.getURL().startsWith("jingler-plan:"))
    return review?.executeJavaScript(
      "fetch('/api/approve', { method: 'POST' }).then((response) => response.status)"
    ) ?? 0
  })).toBe(200)
  await launched.window.getByRole("button", {
    name: "[[plan]] refactor auth to a TokenStore", exact: true
  }).click()
  await expect(
    launched.window.getByText("Implemented and verified the approved plan.").first()
  ).toBeVisible({ timeout: 30_000 })
  await expect(launched.window.locator("[data-mode='auto']")).toContainText("Auto")
})

for (const entry of ["sidebar", "shortcut", "palette"] as const) {
  test(`creates in the selected empty project rather than the previous project via ${entry}`, async ({ launchApp }) => {
    const launched = await launchApp({ configured: true, isolateSystemHome: true })
    const { window } = launched
    const athena = makeProject(launched.home, "Athena")
    const jingler = makeProject(launched.home, "Jingler")
    await expect(appShell(window)).toBeVisible()
    const rail = window.getByTestId("project-sidebar")
    for (const path of [athena, jingler]) {
      await launched.app.evaluate(({ dialog }, selected) => {
        dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [selected] })
      }, path)
      await rail.getByRole("button", { name: "Add project" }).click()
      const dialog = window.getByRole("dialog")
      await dialog.getByRole("option", { name: LOCAL_REPOSITORY }).click()
      await dialog.getByRole("button", { name: "Browse in Finder" }).click()
      await expect(dialog.getByRole("textbox", { name: "Project directory" })).toHaveValue(path)
      await dialog.getByRole("button", { name: "Add project" }).click()
      await expect(dialog).toHaveCount(0)
    }
    await rail.getByRole("button", { name: "Athena", exact: true }).click()
    await createWorkspace(window, { checkout: "Local" })
    await expect.poll(() => realpathSync(JSON.parse(readFileSync(join(launched.home, "jingler", "config.json"), "utf8")).lastRepoPath)).toBe(realpathSync(athena))

    if (entry === "sidebar") {
      await window.getByTestId("new-session").click()
      await expect(window.getByRole("button", { name: "Project", exact: true })).toContainText("Athena")
      await rail.getByRole("button", { name: "Jingler", exact: true }).click()
    } else {
      await rail.getByRole("button", { name: "Jingler", exact: true }).click()
      if (entry === "shortcut") await window.keyboard.press("Meta+n")
      else {
        await window.keyboard.press("Meta+k")
        await window.getByPlaceholder("Jump to a session or run a command…").fill("New Workspace")
        await window.getByRole("option", { name: /New Workspace/ }).click()
      }
    }
    await expect(window.getByRole("button", { name: "Project", exact: true })).toContainText("Jingler")
    await createWorkspace(window, { checkout: "Local" })
    const persisted: ReadonlyArray<{ repoPath: string; worktreePath: string }> = JSON.parse(
      readFileSync(join(launched.home, "jingler", "sessions.json"), "utf8")
    )
    expect(persisted).toHaveLength(2)
    expect(persisted.filter((session) => session.repoPath === realpathSync(athena))).toHaveLength(1)
    expect(persisted.find((session) => session.repoPath === realpathSync(jingler))).toMatchObject({
      worktreePath: realpathSync(jingler)
    })
  })
}
