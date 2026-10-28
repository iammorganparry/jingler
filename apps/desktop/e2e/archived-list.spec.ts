import { execFileSync } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { appShell, confirmArchive, createWorkspace, expect, sessionRow, test } from "./fixtures.js"
import type { SeedSession } from "./fixtures.js"

const plain = (id: string, title: string, repoPath: string, extra: Partial<SeedSession> = {}): SeedSession => ({
  id,
  repo: "widget",
  branch: `chore/${id}`,
  title,
  status: "idle",
  diff: { added: 0, removed: 0 },
  prNumber: null,
  costUsd: 0,
  tokens: 0,
  updatedAt: "2026-07-11T00:00:00.000Z",
  worktreePath: repoPath,
  mode: "accept-edits",
  ...extra
})

const sessions = ({ repoPath }: { repoPath: string }): ReadonlyArray<SeedSession> => [
  plain("s_keep", "First session", repoPath),
  plain("s_act", "Second session", repoPath),
  plain("s_old", "Old billing work", repoPath, { archived: true, archiveReason: "closed", archivedAt: "2026-07-10T00:00:00.000Z" })
]

test("archive via confirm, search the Archived list, Restore, and Delete asks first", async ({ launchApp }) => {
  const { window } = await launchApp({ configured: true, withRepo: true, sessions })
  await expect(appShell(window)).toBeVisible()

  // Archiving always asks first; Cancel leaves the session where it was.
  await sessionRow(window, "Second session").hover()
  await window.getByRole("button", { name: "Archive Second session" }).click()
  const confirm = window.getByRole("dialog", { name: "Archive this workspace?" })
  await expect(confirm).toContainText("Terminal history is saved")
  await confirm.getByRole("button", { name: "Cancel", exact: true }).click()
  await expect(sessionRow(window, "Second session")).toBeVisible()
  await sessionRow(window, "Second session").hover()
  await window.getByRole("button", { name: "Archive Second session" }).click()
  await confirmArchive(window)
  await expect(sessionRow(window, "Second session")).toHaveCount(0)

  // The sidebar entry counts both archived sessions and opens a searchable list.
  const entry = window.getByTestId("archived-sidebar-item")
  await expect(entry).toContainText("2")
  await entry.click()
  const list = window.getByRole("dialog", { name: /^Archived/ })
  await expect(list.getByTestId("archived-row-s_act")).toBeVisible()
  await expect(list.getByTestId("archived-row-s_old")).toBeVisible()
  await list.getByRole("textbox", { name: "Search archived…" }).fill("billing")
  await expect(list.getByTestId("archived-row-s_act")).toHaveCount(0)
  await expect(list.getByTestId("archived-row-s_old")).toBeVisible()

  // Delete is destructive: it asks first, and Cancel keeps the row.
  await list.getByRole("button", { name: "Delete Old billing work" }).click()
  const deleteDialog = window.getByRole("dialog", { name: "Delete session?" })
  await expect(deleteDialog).toBeVisible()
  await deleteDialog.getByRole("button", { name: "Cancel", exact: true }).click()
  await expect(list.getByTestId("archived-row-s_old")).toBeVisible()

  // Restore moves the other workspace back into the sidebar.
  await list.getByRole("textbox", { name: "Search archived…" }).fill("second")
  await list.getByRole("button", { name: "Restore Second session" }).click()
  await expect(sessionRow(window, "Second session")).toBeVisible()
  await expect(list.getByTestId("archived-row-s_act")).toHaveCount(0)

  // Confirming the delete removes it for good.
  await list.getByRole("textbox", { name: "Search archived…" }).fill("")
  await list.getByRole("button", { name: "Delete Old billing work" }).click()
  await window.getByRole("dialog", { name: "Delete session?" }).getByRole("button", { name: "Delete", exact: true }).click()
  await expect(window.getByTestId("archived-sidebar-item")).toHaveCount(0)
})

test("archiving a merged session removes its worktree but keeps it under Archived", async ({ launchApp }) => {
  const { window, repoPath, home } = await launchApp({ configured: true, withRepo: true })
  // A pushed base branch is what makes the fresh worktree's HEAD "pushed".
  const remote = join(home, "remote.git")
  execFileSync("git", ["init", "--bare", "-b", "main", remote])
  execFileSync("git", ["remote", "add", "origin", remote], { cwd: repoPath })
  execFileSync("git", ["push", "-u", "origin", "main"], { cwd: repoPath })

  await expect(appShell(window)).toBeVisible()
  await createWorkspace(window, "", "worktree", repoPath)
  await window.getByPlaceholder("Message the agent…").waitFor()
  const sessions = () => JSON.parse(readFileSync(join(home, "jingler/sessions.json"), "utf8"))
  const worktreePath: string = sessions()[0].worktreePath
  expect(existsSync(worktreePath)).toBe(true)

  const row = window.locator("[data-testid^='session-row-']").first(); await row.hover()
  await row.getByRole("button", { name: /^Archive / }).click()
  await confirmArchive(window)

  await expect.poll(() => sessions()[0]?.archived).toBe(true)
  await expect.poll(() => existsSync(worktreePath)).toBe(false)
  expect(sessions()[0].worktreeKeptReason).toBeUndefined()
})
