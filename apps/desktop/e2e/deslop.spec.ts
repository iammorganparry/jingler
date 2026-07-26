import { writeFileSync } from "node:fs"
import { join } from "node:path"
import { expect, test } from "./fixtures.js"
import type { SeedSession } from "./fixtures.js"

/**
 * The per-file "Deslop" button in the Code Review file list hands that file to
 * the session's agent for an in-place cleanup pass — a normal turn on the
 * session's OWN worktree, so it works for committed and uncommitted changes
 * alike. This drives the real path a user takes; the scripted agent stands in
 * for the harness, so nothing hits the network.
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
  worktreePath
})

test("Deslop button sends the file to the session's agent", async ({ launchApp }) => {
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
  await window.getByRole("button", { name: "Changes" }).first().click()

  // The Deslop button sits in each file's sticky header, beside Revert file.
  const deslop = window.getByRole("button", { name: "Deslop" }).first()
  await expect(deslop).toBeVisible({ timeout: 30_000 })
  await deslop.click()

  // The cleanup runs as a turn on THIS session — its prompt lands in the
  // Conversation tab, not a new session.
  await window.getByRole("button", { name: "Conversation" }).click()
  await expect(
    window.getByText(/Pull repeated logic into shared helpers/).first()
  ).toBeVisible({ timeout: 30_000 })
})
