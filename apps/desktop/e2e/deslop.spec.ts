import { execFileSync } from "node:child_process"
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
 *
 * The seeded session lives in its OWN worktree on its OWN branch, distinct from
 * the origin repo — the real topology. That matters because the deslop session
 * forks from the current session's branch (where the reviewed changes live), not
 * the origin's default branch.
 */

const SESSION_BRANCH = "starbase/deslop-session"
const WORKTREE_DIRNAME = "deslop-session-wt"

const seeded = (repoPath: string, worktreePath: string): SeedSession => ({
  id: "s_deslop_1",
  repo: "widget",
  branch: SESSION_BRANCH,
  title: "Deslop source session",
  status: "idle",
  cli: "claude",
  diff: { added: 2, removed: 0 },
  prNumber: null,
  costUsd: 0,
  tokens: 0,
  updatedAt: "2026-07-18T00:00:00.000Z",
  // The session's own worktree, checked out on its branch — separate from the
  // origin repo the button forks a fresh cleanup worktree from.
  worktreePath,
  repoPath,
  baseBranch: "main"
})

test("Deslop button spawns an isolated cleanup session for a file", async ({ launchApp }) => {
  const { window } = await launchApp({
    configured: true,
    withRepo: true,
    sessions: ({ reposDir, repoPath }) => [seeded(repoPath, join(reposDir, WORKTREE_DIRNAME))],
    // Put the session on its own branch + worktree (real topology), then leave an
    // uncommitted change in that worktree so the local "Changes" source lists a file.
    seed: ({ reposDir, repoPath }) => {
      const worktree = join(reposDir, WORKTREE_DIRNAME)
      execFileSync("git", ["-C", repoPath, "branch", SESSION_BRANCH, "main"])
      execFileSync("git", ["-C", repoPath, "worktree", "add", worktree, SESSION_BRANCH])
      writeFileSync(
        join(worktree, "README.md"),
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
