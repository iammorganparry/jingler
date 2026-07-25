import { writeFileSync } from "node:fs"
import { join } from "node:path"
import { expect, test } from "./fixtures.js"
import type { SeedSession } from "./fixtures.js"

/**
 * The per-file "Deslop" button in the Code Review file list spawns a dedicated,
 * ISOLATED cleanup session (its own worktree + branch), so the refactor runs
 * immediately rather than queuing behind the current session's turn. This drives
 * the real create → run path a user takes; the scripted agent stands in for the
 * harness, so nothing hits the network.
 */

const seeded = (worktreePath: string): SeedSession => ({
  id: "s_deslop_1",
  repo: "widget",
  branch: "starbase/deslop-session",
  title: "Deslop source session",
  status: "idle",
  cli: "claude",
  diff: { added: 2, removed: 0 },
  prNumber: null,
  costUsd: 0,
  tokens: 0,
  updatedAt: "2026-07-18T00:00:00.000Z",
  worktreePath,
  // Real sessions carry the origin repo path; the Deslop button needs it to fork
  // a fresh cleanup session. The seeded worktree IS the repo here.
  repoPath: worktreePath,
  baseBranch: "main"
})

test("Deslop button spawns an isolated cleanup session for a file", async ({ launchApp }) => {
  const { window } = await launchApp({
    configured: true,
    withRepo: true,
    sessions: ({ repoPath }) => [seeded(repoPath)],
    // Give the worktree an uncommitted change so the local Code Review source
    // ("Changes" tab) has a file to list.
    seed: ({ repoPath }) => {
      writeFileSync(
        join(repoPath, "README.md"),
        "# e2e repo\n\nconst a = 1\nconst a2 = 1\nconst a3 = 1\n"
      )
    }
  })

  await window.getByText("Deslop source session").click()
  // No PR yet, so the local worktree diff lives on the "Changes" tab.
  await window.getByText("Changes").first().click()

  // The Deslop button sits in each file's sticky header, beside Revert file.
  const deslop = window.getByRole("button", { name: "Deslop" }).first()
  await expect(deslop).toBeVisible({ timeout: 30_000 })
  await deslop.click()

  // A brand-new session, titled after the file, appears in the sidebar.
  await expect(window.getByText(/^Deslop README\.md$/)).toBeVisible({ timeout: 30_000 })
})
