import { execFileSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { appShell, expect, openSessionByTitle, test } from "./fixtures.js"
import type { SeedSession } from "./fixtures.js"

/**
 * A DIRECT session shares the developer's primary checkout, so it hard-pins to a
 * branch. When the agent (or the developer) moves that checkout to a new branch,
 * continuing would run the turn against a branch the session's plans and review
 * state do not name — so the turn stops. Instead of a dead-end error, the
 * transcript shows a recovery banner: fork the work onto a new worktree session
 * on the live branch, or adopt the live branch into this session.
 */

const git = (cwd: string, args: ReadonlyArray<string>): string =>
  execFileSync("git", [...args], { cwd, encoding: "utf8" }).trim()

const sessions = (home: string): Array<{ title: string; branch: string }> =>
  JSON.parse(readFileSync(join(home, "jingler", "sessions.json"), "utf8"))

const directSession = (repoPath: string): SeedSession => ({
  id: "s_direct_drift",
  repo: "widget",
  branch: "main",
  title: "Direct fix",
  status: "idle",
  diff: { added: 0, removed: 0 },
  prNumber: null,
  costUsd: 0,
  tokens: 0,
  updatedAt: "2026-08-19T00:00:00.000Z",
  workspaceMode: "direct",
  worktreePath: repoPath,
  repoPath,
})

test("a drifted direct session surfaces the recovery banner and adopts the live branch", async ({
  launchApp,
}) => {
  const { window, home, repoPath } = await launchApp({
    configured: true,
    withRepo: true,
    sessions: ({ repoPath }) => [directSession(repoPath)],
  })

  await expect(appShell(window)).toBeVisible()

  // Move the shared checkout off `main`, exactly as an agent's `git switch -c`
  // would — the session is still pinned to `main`.
  git(repoPath, ["checkout", "-b", "fix/other"])

  await openSessionByTitle(window, "Direct fix")
  const composer = window.getByPlaceholder("Message the agent…")
  await composer.fill("continue")
  await composer.press("Enter")

  // The turn stops on the pin and renders the recovery banner, not an error line.
  await expect(window.getByText("Checkout moved off main")).toBeVisible({
    timeout: 20_000,
  })
  await expect(
    window.getByRole("button", { name: "Fork new session" }),
  ).toBeVisible()
  const adopt = window.getByRole("button", { name: "Adopt fix/other" })
  await expect(adopt).toBeVisible()

  // Adopt re-points the session at the branch the checkout is now on.
  await adopt.click()
  await expect
    .poll(() => sessions(home).find((s) => s.title === "Direct fix")?.branch, {
      timeout: 15_000,
    })
    .toBe("fix/other")
})
