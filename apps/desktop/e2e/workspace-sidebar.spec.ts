import { appShell, expect, test } from "./fixtures.js"
import type { SeedSession } from "./fixtures.js"

const session = (id: string, repo: string, extra: Partial<SeedSession> = {}): SeedSession => ({
  id,
  repo,
  branch: "main",
  title: id,
  status: "idle",
  diff: { added: 0, removed: 0 },
  prNumber: null,
  costUsd: 0,
  tokens: 0,
  updatedAt: "2026-08-07T12:00:00.000Z",
  ...extra
})

const launch = (launchApp: Parameters<Parameters<typeof test>[2]>[0]["launchApp"]) =>
  launchApp({
    configured: true,
    withRepo: true,
    sessions: ({ repoPath }) => [
      session("s_alpha", "alpha", { worktreePath: repoPath }),
      session("s_beta", "beta", { worktreePath: repoPath }),
      session("s_multi", "alpha", {
        worktreePath: repoPath,
        checkouts: [
          { id: "a", repo: "alpha", branch: "main", prNumber: null, worktreePath: repoPath },
          { id: "b", repo: "beta", branch: "main", prNumber: null, worktreePath: repoPath }
        ],
        activeCheckoutId: "a"
      })
    ]
  })

const IDS = ["s_alpha", "s_beta", "s_multi"]

test("repo filter matches any checkout", async ({ launchApp }) => {
  const { window } = await launch(launchApp)
  await expect(appShell(window)).toBeVisible()
  const row = (id: string) => window.getByTestId(`session-row-${id}`)
  await expect(row("s_multi").getByTestId("repo-chip-alpha")).toBeVisible()
  await expect(row("s_multi").getByTestId("repo-chip-beta")).toBeVisible()

  for (const [repo, hidden, shown] of [["alpha", "s_beta", "s_alpha"], ["beta", "s_alpha", "s_beta"]]) {
    await window.getByTestId("session-filter-menu").click()
    await window.getByRole("menuitem", { name: /^Repository/ }).click()
    await window.getByRole("menuitem", { name: new RegExp(`^${repo}`) }).click()
    await expect(row(shown)).toBeVisible()
    await expect(row("s_multi")).toBeVisible()
    await expect(row(hidden!)).toHaveCount(0)
  }
})

test("there is no project rail and every workspace is listed unfiltered", async ({ launchApp }) => {
  const { window } = await launch(launchApp)
  await expect(appShell(window)).toBeVisible()
  await expect(window.getByTestId("project-sidebar")).toHaveCount(0)
  for (const id of IDS) await expect(window.getByTestId(`session-row-${id}`)).toBeVisible()
})
