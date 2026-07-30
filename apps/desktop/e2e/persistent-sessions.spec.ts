import { execFileSync } from "node:child_process"
import { existsSync, readFileSync, realpathSync } from "node:fs"
import { join } from "node:path"
import {
  appShell,
  expect,
  sessionRow,
  showSessions,
  test
} from "./fixtures.js"
import type { SeedSession } from "./fixtures.js"

const keptSession = (worktreePath: string): SeedSession => ({
  id: "s_kept",
  repo: "widget",
  repoPath: worktreePath,
  branch: "main",
  baseBranch: "main",
  worktreePath,
  title: "Keep auth warm",
  status: "idle",
  cli: "claude",
  diff: { added: 0, removed: 0 },
  prNumber: null,
  costUsd: 0,
  tokens: 0,
  updatedAt: "2026-07-30T10:00:00.000Z"
})

const storedSession = (home: string): Record<string, unknown> =>
  JSON.parse(
    readFileSync(join(home, "jingler", "sessions.json"), "utf-8")
  )[0] as Record<string, unknown>

const storedSessions = (home: string): ReadonlyArray<Record<string, unknown>> =>
  JSON.parse(
    readFileSync(join(home, "jingler", "sessions.json"), "utf-8")
  ) as ReadonlyArray<Record<string, unknown>>

const gitLines = (
  repoPath: string,
  args: ReadonlyArray<string>
): ReadonlyArray<string> =>
  execFileSync("git", args, {
    cwd: repoPath,
    encoding: "utf-8"
  })
    .split("\n")
    .filter((line) => line.length > 0)

test("a persistent tile survives an Electron restart and can be unpersisted", async ({
  launchApp
}) => {
  const first = await launchApp({
    configured: true,
    withRepo: true,
    sessions: ({ repoPath }) => [keptSession(repoPath)]
  })

  await expect(appShell(first.window)).toBeVisible()
  const row = sessionRow(first.window, "Keep auth warm")
  await row.click({ button: "right" })
  await first.window.getByRole("menuitem", { name: "Persist" }).click()
  await expect(
    first.window.getByTestId("persistent-session-tile-s_kept")
  ).toBeVisible()
  expect(storedSession(first.home).persistent).toBe(true)

  await first.app.close()

  const second = await launchApp({
    home: first.home,
    reposDir: first.reposDir,
    userDataDir: first.userDataDir,
    configured: true,
    withRepo: true
  })
  await expect(appShell(second.window)).toBeVisible()

  const restoredTile = second.window.getByTestId(
    "persistent-session-tile-s_kept"
  )
  await expect(restoredTile).toBeVisible()
  await expect(sessionRow(second.window, "Keep auth warm")).toHaveCount(0)
  expect(storedSession(second.home).persistent).toBe(true)

  await restoredTile.click({ button: "right" })
  await second.window.getByRole("menuitem", { name: "Unpersist" }).click()

  await expect(restoredTile).toHaveCount(0)
  await expect(sessionRow(second.window, "Keep auth warm")).toBeVisible()
  await expect(
    second.window.getByTestId("persistent-session-add")
  ).toHaveCount(1)
  expect(storedSession(second.home).persistent).toBe(false)
})

test("a session moves between its ordinary row and persistent tray across archive restore", async ({
  launchApp
}) => {
  const { window, home } = await launchApp({
    configured: true,
    withRepo: true,
    sessions: ({ repoPath }) => [keptSession(repoPath)]
  })

  await expect(appShell(window)).toBeVisible()
  const row = sessionRow(window, "Keep auth warm")
  await expect(row).toBeVisible()
  await row.click({ button: "right" })
  await window.getByRole("menuitem", { name: "Persist" }).click()

  const tile = window.getByTestId("persistent-session-tile-s_kept")
  await expect(tile).toBeVisible()
  await expect(row).toHaveCount(0)
  expect(storedSession(home).persistent).toBe(true)

  // Delete still routes through the shared confirmation flow.
  await tile.click({ button: "right" })
  await window.getByRole("menuitem", { name: "Delete" }).click()
  await expect(window.getByRole("heading", { name: "Delete session?" })).toBeVisible()
  await window.getByRole("button", { name: "Cancel" }).click()

  // Unpersist restores the ordinary grouped row without creating a duplicate.
  await tile.click({ button: "right" })
  await window.getByRole("menuitem", { name: "Unpersist" }).click()
  await expect(sessionRow(window, "Keep auth warm")).toBeVisible()
  await expect(tile).toHaveCount(0)
  expect(storedSession(home).persistent).toBe(false)

  // Promote once more, then archive from the tile. The flag survives while the
  // archived session is represented by the ordinary history row.
  const restoredRow = sessionRow(window, "Keep auth warm")
  await restoredRow.click({ button: "right" })
  await window.getByRole("menuitem", { name: "Persist" }).click()
  await expect(tile).toBeVisible()
  await tile.click({ button: "right" })
  await window.getByRole("menuitem", { name: "Archive" }).click()
  await expect(tile).toHaveCount(0)
  await expect(window.getByTestId("persistent-session-add")).toBeVisible()
  expect(storedSession(home)).toMatchObject({
    persistent: true,
    archived: true
  })

  await showSessions(window, "Archived")
  const archivedRow = sessionRow(window, "Keep auth warm")
  await expect(archivedRow).toBeVisible()
  await archivedRow.click({ button: "right" })
  await window.getByRole("menuitem", { name: "Restore" }).click()

  await expect(tile).toBeVisible()
  await expect(archivedRow).toHaveCount(0)
  expect(storedSession(home)).toMatchObject({
    persistent: true,
    archived: false
  })
})

test("a direct session completes a turn and deletion preserves its checkout", async ({
  launchApp
}) => {
  const { window, home, repoPath } = await launchApp({
    configured: true,
    withRepo: true
  })
  const initialHead = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: repoPath,
    encoding: "utf-8"
  }).trim()
  const initialBranches = gitLines(repoPath, [
    "branch",
    "--format=%(refname:short)"
  ])
  const initialWorktrees = gitLines(repoPath, [
    "worktree",
    "list",
    "--porcelain"
  ]).filter((line) => line.startsWith("worktree "))
  const committedReadme = readFileSync(join(repoPath, "README.md"), "utf-8")

  await expect(appShell(window)).toBeVisible()
  await window.getByTestId("new-session").click()
  const worktree = window.getByRole("switch", {
    name: "Use isolated worktree"
  })
  await expect(worktree).toBeChecked()
  await worktree.click()
  await window
    .getByPlaceholder("Leave blank for agent naming")
    .fill("Direct checkout proof")
  await window.getByRole("button", { name: "Create" }).click()

  const row = sessionRow(window, "Direct checkout proof")
  await expect(row).toBeVisible()
  const created = storedSession(home)
  expect(created).toMatchObject({
    title: "Direct checkout proof",
    branch: "main",
    baseBranch: "main",
    repoPath,
    worktreePath: repoPath,
    workspaceMode: "direct"
  })
  expect(gitLines(repoPath, ["worktree", "list", "--porcelain"]).filter(
    (line) => line.startsWith("worktree ")
  )).toEqual([`worktree ${realpathSync(repoPath)}`])
  expect(gitLines(repoPath, ["branch", "--format=%(refname:short)"])).toEqual(
    initialBranches
  )
  expect(initialBranches.some((branch) => branch.startsWith("jingler/"))).toBe(
    false
  )

  const composer = window.getByPlaceholder("Message Claude…")
  await expect(composer).toBeVisible()
  const jingler = window.getByRole("button", { name: "Jingler", exact: true })
  if ((await jingler.getAttribute("aria-pressed")) === "true") {
    await jingler.click()
  }
  await window.getByRole("button", { name: "plan", exact: true }).click()
  await window.getByRole("menuitem", { name: "auto" }).click()
  await composer.fill("Run the direct-checkout verification.")
  await composer.press("Enter")
  await expect(window.getByText("1 passed")).toBeVisible({ timeout: 25_000 })
  await expect(composer).toBeVisible()

  await row.click({ button: "right" })
  await window.getByRole("menuitem", { name: "Delete" }).click()
  const dialog = window.getByRole("dialog")
  await expect(
    dialog.getByText("The repository checkout will be left untouched.", {
      exact: false
    })
  ).toBeVisible()
  await dialog.getByRole("button", { name: "Delete" }).click()

  await expect(row).toHaveCount(0)
  await expect.poll(() => storedSessions(home)).toEqual([])
  expect(existsSync(repoPath)).toBe(true)
  expect(readFileSync(join(repoPath, "README.md"), "utf-8")).toBe(
    committedReadme
  )
  expect(
    execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
      cwd: repoPath,
      encoding: "utf-8"
    }).trim()
  ).toBe("main")
  expect(
    execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: repoPath,
      encoding: "utf-8"
    }).trim()
  ).toBe(initialHead)
  expect(gitLines(repoPath, ["branch", "--format=%(refname:short)"])).toEqual(
    initialBranches
  )
  expect(gitLines(repoPath, ["worktree", "list", "--porcelain"]).filter(
    (line) => line.startsWith("worktree ")
  )).toEqual(initialWorktrees)
})
