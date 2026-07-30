import { readFileSync } from "node:fs"
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
