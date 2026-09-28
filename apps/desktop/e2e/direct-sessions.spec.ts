import { execFileSync } from "node:child_process"
import {
  existsSync,
  readFileSync,
  realpathSync,
  statSync
} from "node:fs"
import { join } from "node:path"
import {
  appShell,
  createWorkspace,
  expect,
  sessionRow,
  test
} from "./fixtures.js"

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
  await createWorkspace(window, "Direct checkout proof", "direct", repoPath)

  await expect.poll(() => existsSync(join(home, "jingler", "sessions.json"))).toBe(true)
  const created = storedSession(home)
  const row = window.getByTestId(`session-row-${String(created.id)}`)
  await expect(row).toBeVisible()
  expect(created).toMatchObject({
    autoTitle: true,
    branch: "main",
    baseBranch: "main",
    workspaceMode: "direct"
  })
  expect(created.worktreePath).toBe(created.repoPath)
  expect(statSync(created.worktreePath).ino).toBe(statSync(repoPath).ino)
  expect(gitLines(repoPath, ["worktree", "list", "--porcelain"]).filter(
    (line) => line.startsWith("worktree ")
  )).toEqual([`worktree ${realpathSync(repoPath)}`])
  expect(gitLines(repoPath, ["branch", "--format=%(refname:short)"])).toEqual(
    initialBranches
  )
  expect(initialBranches.some((branch) => branch.startsWith("jingler/"))).toBe(
    false
  )

  const composer = window.getByPlaceholder("Message the agent…")
  await expect(composer).toBeVisible()
  await expect(window.getByRole("button", { name: "Auto" })).toBeVisible()
  await composer.fill("Run the direct-checkout verification.")
  await composer.press("Enter")
  await expect(
    window.getByText("Completed through deterministic pi.", { exact: false })
  ).toBeVisible({ timeout: 25_000 })
  await expect(composer).toBeVisible()

  await expect(sessionRow(window, "Run the direct-checkout verification")).toBeVisible()
  await row.hover()
  await window
    .getByRole("button", { name: "Delete Run the direct-checkout verification" })
    .click()
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
