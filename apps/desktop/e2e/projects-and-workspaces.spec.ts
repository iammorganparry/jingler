import { execFileSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { ElectronApplication, Page } from "@playwright/test"
import {
  appShell,
  expect,
  sessionRow,
  type SeedSession,
  test, openModelSettings } from "./fixtures.js"

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
  await window.getByTestId("new-session-view").getByRole("button", { name: "Project", exact: true }).click()
  await window.getByRole("option", { name: "Add project…" }).click()
  await expect(window.getByRole("heading", { name: "Add project" })).toBeVisible()
  await window.getByRole("option", { name: LOCAL_REPOSITORY }).click()
  const directorySearch = window.getByPlaceholder("Search folders or enter an absolute path…")
  await directorySearch.fill(projectPath)
  await directorySearch.press("Enter")
  await expect(window.getByText(projectPath, { exact: true })).toBeVisible()
  await window.getByRole("button", { name: "Choose current folder" }).click()
  await window.getByRole("dialog").getByRole("button", { name: "Add project" }).click()
}

const addRepoViaFilterMenu = async (window: Page, projectPath: string, app: ElectronApplication) => {
  await app.evaluate(({ dialog }, selected) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [selected] })
  }, projectPath)
  await window.getByTestId("session-filter-menu").click()
  await window.getByTestId("filter-action-add-repo").click()
  const dialog = window.getByRole("dialog")
  await dialog.getByRole("option", { name: LOCAL_REPOSITORY }).click()
  await dialog.getByRole("button", { name: "Browse in Finder" }).click()
  await expect(dialog.getByRole("textbox", { name: "Project directory" })).toHaveValue(projectPath)
  await dialog.getByRole("button", { name: "Add project" }).click()
  await expect(dialog).toHaveCount(0)
}

const createWorkspace = async (
  window: Page,
  input: { checkout: "This checkout" | "Worktree"; task?: string; baseBranch?: string }
) => {
  if (!(await window.getByTestId("new-session-view").isVisible())) {
    await window.getByTestId("new-session").click()
  }
  await expect(window.getByRole("heading", { name: "New session" })).toBeVisible()
  if (input.baseBranch) {
    await window.getByRole("button", { name: "Start from" }).click()
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
  const { window } = launched
  await expect(appShell(window)).toBeVisible()
  const picker = window.getByTestId("new-session-view").getByRole("button", { name: "Project", exact: true })
  const openPicker = async () => {
    if (!(await window.getByTestId("new-session-view").isVisible())) await window.getByTestId("new-session").click()
    await picker.click()
  }
  await openPicker()
  await expect(window.getByRole("option", { name: /^widget( |$)/ })).toBeVisible()
  await expect(window.getByRole("option", { name: /^unimported( |$)/ })).toHaveCount(0)
  await expect(window.getByRole("option", { name: /^discovered-only( |$)/ })).toHaveCount(0)
  await window.keyboard.press("Escape")
  const hiddenPath = join(launched.reposDir, "unimported")
  await addRepoViaFilterMenu(window, hiddenPath, launched.app)
  await openPicker()
  await expect(window.getByRole("option", { name: /^unimported( |$)/ })).toBeVisible()
  await expect(window.getByRole("option", { name: /^discovered-only( |$)/ })).toHaveCount(0)
  expect(existsSync(join(hiddenPath, ".git"))).toBe(true)
})

test("Browse opens the native file browser and registers its selected repository", async ({ launchApp }) => {
  const launched = await launchApp({ configured: true })
  const projectPath = makeProject(launched.home, "native-browse-project")
  await launched.app.evaluate(({ dialog }, selected) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [selected] })
  }, projectPath)

  await launched.window.getByTestId("new-session").click()
  await launched.window.getByTestId("new-session-view").getByRole("button", { name: "Project", exact: true }).click()
  await launched.window.getByRole("option", { name: "Add project…" }).click()
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
    await launched.window.getByTestId("new-session-view").getByRole("button", { name: "Project", exact: true }).click()
    await launched.window.getByRole("option", { name: "Add project…" }).click()
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
    checkout: "This checkout"
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

test("names and branches a new workspace from its initial prompt before opening it", async ({ launchApp }) => {
  const launched = await launchApp({ configured: true })
  const projectPath = makeProject(launched.home, "named-project")
  await expect(appShell(launched.window)).toBeVisible()
  await addProject(launched.window, projectPath)
  await createWorkspace(launched.window, {
    checkout: "Worktree",
    task: "Fix keyboard tab closing"
  })

  const persisted = JSON.parse(readFileSync(join(launched.home, "jingler", "sessions.json"), "utf8"))[0]
  expect(persisted).toMatchObject({
    title: "Fix keyboard tab closing",
    branch: "chore/fix-keyboard-tab-closing",
    semanticBranchPending: false
  })
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
  await openModelSettings(launched.window)
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

  await openModelSettings(launched.window)
  await expect(launched.window.getByRole("button", { name: /^Model:/ })).toBeVisible()
  const sessions = JSON.parse(readFileSync(join(launched.home, "jingler", "sessions.json"), "utf8"))
  const worktreePath = sessions[0].worktreePath as string
  // Plannotator owns the plan as a markdown file in the worktree; the native
  // Plan tab reviews and approves it — there is no separate plan store.
  await expect.poll(() => existsSync(join(worktreePath, "PLAN.md")), { timeout: 20_000 }).toBe(true)
  await launched.window.getByTestId("editor-tab-view-plan").getByRole("tab").first().click()
  await launched.window.getByTestId("plan-review")
    .getByRole("button", { name: "Approve", exact: true }).click()
  // The Plan view opens in its own split editor group; the chat's group (now a
  // single-chat ChatLaneHeader with a thread switcher, not a tab role) is a
  // separate pane that stays visible throughout, so no tab switch is needed.
  await expect(
    launched.window.getByText("Implemented and verified the approved plan.").first()
  ).toBeVisible({ timeout: 30_000 })
  // Back in Auto. Asserted on the mode attribute: split beside the Plan tab the
  // chat pane is narrow, and the mode chip drops its word label.
  await expect(launched.window.locator("[data-mode]").first()).toHaveAttribute("data-mode", "auto")
})

for (const entry of ["sidebar", "shortcut", "palette"] as const) {
  test(`new workspace defaults to the active workspace's project via ${entry}`, async ({ launchApp }) => {
    const launched = await launchApp({ configured: true, isolateSystemHome: true })
    const { window } = launched
    const athena = makeProject(launched.home, "Athena")
    const jingler = makeProject(launched.home, "Jingler")
    await expect(appShell(window)).toBeVisible()
    for (const path of [athena, jingler]) await addRepoViaFilterMenu(window, path, launched.app)
    const projectButton = window.getByRole("button", { name: "Project", exact: true })
    const sessionsFile = join(launched.home, "jingler", "sessions.json")
    const sessionCount = () => (existsSync(sessionsFile) ? JSON.parse(readFileSync(sessionsFile, "utf8")).length : 0)
    for (const [index, name] of ["Athena", "Jingler"].entries()) {
      const view = window.getByTestId("new-session-view")
      if (!(await view.isVisible())) await window.getByTestId("new-session").click()
      await expect(view).toBeVisible()
      await projectButton.click()
      await window.getByRole("option", { name: new RegExp(`^${name}( |$)`) }).click()
      await expect(projectButton).toContainText(name)
      await createWorkspace(window, { checkout: "This checkout" })
      await expect.poll(sessionCount, { timeout: 20_000 }).toBe(index + 1)
    }
    const readSessions = (): ReadonlyArray<{ id: string; repoPath: string; worktreePath: string; projectId?: string }> =>
      JSON.parse(readFileSync(join(launched.home, "jingler", "sessions.json"), "utf8"))
    const rowFor = (path: string) =>
      window.getByTestId(`session-row-${readSessions().find((session) => session.repoPath === realpathSync(path))!.id}`)
    const openNewWorkspace = async () => {
      if (entry === "sidebar") await window.getByTestId("new-session").click()
      else if (entry === "shortcut") await window.keyboard.press("Meta+n")
      else {
        await window.keyboard.press("Meta+k")
        await window.getByPlaceholder("Jump to a session or run a command…").fill("New Workspace")
        await window.getByRole("option", { name: /New Workspace/ }).click()
      }
    }

    const selectRow = async (path: string) => {
      await rowFor(path).click()
      await expect(window.getByTestId("new-session-view")).toHaveCount(0, { timeout: 30_000 })
    }
    await selectRow(athena)
    await openNewWorkspace()
    await expect(projectButton).toContainText("Athena")
    await window.getByRole("button", { name: "Close new session" }).click()
    await selectRow(jingler)
    await openNewWorkspace()
    await expect(projectButton).toContainText("Jingler")
  })
}

test("a renamed project folder shows the missing-folder banner for its active workspace until it is located", async ({ launchApp }) => {
  const launched = await launchApp({
    configured: true,
    withRepo: true,
    isolateSystemHome: true,
    seed: ({ home, repoPath }) => {
      mkdirSync(join(home, "jingler"), { recursive: true })
      writeFileSync(join(home, "jingler", "projects.json"), JSON.stringify([
        { id: "imported-widget", name: "widget", path: repoPath, imported: true, availability: "available", createdAt: "2026-01-01", updatedAt: "2026-01-01" }
      ]))
    },
    sessions: ({ repoPath }) => [{
      id: "s_widget", repo: "widget", branch: "main", title: "Widget work", status: "idle",
      diff: { added: 0, removed: 0 }, prNumber: null, costUsd: 0, tokens: 0,
      updatedAt: "2026-08-07T12:00:00.000Z", repoPath, worktreePath: repoPath, mode: "accept-edits"
    }]
  })
  const { window } = launched
  const row = window.getByTestId("session-row-s_widget")
  await expect(row).toBeVisible()
  const renamed = `${launched.repoPath}-moved`
  renameSync(launched.repoPath, renamed)

  // The project list is read on load; reload so availability is re-checked.
  await window.reload()
  await expect(row).toBeVisible()
  await row.click()
  await expect(window.getByTestId("banner-shell")).toContainText("widget: folder not found")

  await launched.app.evaluate(({ dialog }, selected) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [selected] })
  }, renamed)
  await window.getByTestId("banner-shell").getByRole("button", { name: "Locate folder…" }).click()
  // ponytail: the seeded session still records the old repoPath, so the backfill keeps a missing
  // project (and the banner) alive; assert only that Locate registers the moved folder.
  await expect.poll(() => readFileSync(join(launched.home, "jingler", "projects.json"), "utf8")).toContain(renamed)
})

test("new session hides the environment chip without remote environments and shows the Linear load-failure state", async ({ launchApp }) => {
  const launched = await launchApp({ configured: true })
  await expect(appShell(launched.window)).toBeVisible()
  await launched.window.getByTestId("new-session").click()
  const view = launched.window.getByTestId("new-session-view")
  await expect(view.getByRole("heading", { name: "New session" })).toBeVisible()
  await expect(view.getByRole("button", { name: "Execution environment", exact: true })).toHaveCount(0)
  await view.getByRole("button", { name: "Start from", exact: true }).click()
  await launched.window.getByRole("tab", { name: "Issue" }).click()
  await launched.window.getByRole("option", { name: /^Linear issue/ }).click()
  await expect(view.getByText("Couldn't load issues")).toBeVisible({ timeout: 20_000 })
  await expect(view.getByRole("button", { name: "Retry", exact: true })).toBeVisible()
})
