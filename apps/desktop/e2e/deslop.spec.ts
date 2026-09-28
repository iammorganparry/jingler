import { writeFileSync } from "node:fs"
import { join } from "node:path"
import { expect, sessionRow, test } from "./fixtures.js"
import { openChangedFile } from "./explorer.js"
import type { SeedSession } from "./fixtures.js"

/**
 * The per-file "Deslop" button in a changed file's review diff hands that file to
 * the session's agent for an in-place cleanup pass — a normal turn on the
 * session's OWN worktree, so it works for committed and uncommitted changes
 * alike. This drives the real path a user takes; the deterministic pi provider
 * keeps the run offline.
 */

const seeded = (worktreePath: string): SeedSession => ({
  id: "s_deslop_1",
  repo: "widget",
  branch: "chore/deslop-session",
  title: "Deslop source session",
  status: "idle",
  diff: { added: 2, removed: 0 },
  prNumber: null,
  costUsd: 0,
  tokens: 0,
  updatedAt: "2026-07-18T00:00:00.000Z",
  worktreePath
})

test("Deslop button sends the file to the session's agent", async ({ launchApp }) => {
  const { window } = await launchApp({
    configured: true,
    withRepo: true,
    sessions: ({ repoPath }) => [seeded(repoPath)],
    // Give the worktree an uncommitted change so Changes has a file to list.
    seed: ({ repoPath }) => {
      writeFileSync(
        join(repoPath, "README.md"),
        "# e2e repo\n\nconst a = 1\nconst a2 = 1\nconst a3 = 1\n"
      )
    }
  })

  await sessionRow(window, "Deslop source session").click()
  // No PR yet, so Changes lists the uncommitted work; open the file's diff.
  const diff = await openChangedFile(window, "README.md")

  // The Deslop button sits in the file's sticky header, beside Revert file.
  const deslop = diff.getByRole("button", { name: "Deslop" }).first()
  await expect(deslop).toBeVisible({ timeout: 30_000 })
  await deslop.click()

  // The cleanup runs as a turn on THIS session — its prompt lands in the
  // Conversation tab, not a new session.
  await window.getByRole("button", { name: "Chat 1", exact: true }).click()
  await expect(
    window.getByText(/Pull repeated logic into shared helpers/).first()
  ).toBeVisible({ timeout: 30_000 })
})
