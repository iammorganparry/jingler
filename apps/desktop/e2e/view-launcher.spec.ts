/**
 * Header view launchers (#383): pin from the ⋯ overflow menu, ⌘⇧D opens Changes,
 * and the header refuses a sixth pinned view.
 */
import { expect, test } from "./fixtures.js"
import type { SeedSession } from "./fixtures.js"

const session: SeedSession = {
  id: "s_view_launcher",
  repo: "widget",
  branch: "feat/view-launcher",
  title: "View launcher test",
  status: "idle",
  diff: { added: 0, removed: 0 },
  prNumber: null,
  costUsd: 0,
  tokens: 0,
  updatedAt: "2026-10-12T10:00:00.000Z"
}

const launch = (launchApp: Parameters<Parameters<typeof test>[2]>[0]["launchApp"], headerViews?: string[]) =>
  launchApp({
    configured: true,
    withRepo: true,
    ...(headerViews ? { config: { headerViews } } : {}),
    sessions: (context) => [{ ...session, worktreePath: context.repoPath }]
  })

test("pinning a view from the overflow menu adds it to the header", async ({ launchApp }) => {
  const { window } = await launch(launchApp, ["changes"])
  await window.getByTestId("session-row-s_view_launcher").click()

  await expect(window.getByTestId("header-view-buttons")).toBeVisible()
  await expect(window.getByTestId("header-view-terminal")).toHaveCount(0)

  await window.getByTestId("view-overflow-trigger").click()
  await window.getByTestId("pin-terminal").click()
  await expect(window.getByTestId("header-view-terminal")).toBeVisible()
})

test("⌘⇧D opens Changes in the focused content group", async ({ launchApp }) => {
  const { window } = await launch(launchApp)
  await window.getByTestId("session-row-s_view_launcher").click()
  await expect(window.getByTestId("header-view-changes")).toBeVisible()
  await expect(window.getByTestId("changed-files-explorer")).toHaveCount(0)

  await window.keyboard.press("Meta+Shift+d")
  await expect(window.getByTestId("changed-files-explorer")).toBeVisible()
})

test("with five views pinned, pinning a sixth is refused", async ({ launchApp }) => {
  const { window } = await launch(launchApp, ["changes", "checks", "files", "plan", "explanation"])
  await window.getByTestId("session-row-s_view_launcher").click()
  await expect(window.locator('[data-testid^="header-view-"]:not([data-testid="header-view-buttons"])')).toHaveCount(2)

  await window.getByTestId("view-overflow-trigger").click()
  const refused = window.getByTestId("pin-terminal")
  await expect(refused).toHaveAttribute("aria-disabled", "true")
  await expect(refused).toBeVisible()
  await refused.hover()
  await expect(window.getByText("Header is full (5 pinned). Unpin a view first.").first()).toBeVisible()

  await refused.click({ force: true })
  await expect(window.locator('[data-testid^="header-view-"]:not([data-testid="header-view-buttons"])')).toHaveCount(2)
})

test("no right view rail renders at narrow or wide widths", async ({ launchApp }) => {
  const { window } = await launch(launchApp)
  await window.getByTestId("session-row-s_view_launcher").click()
  await expect(window.getByTestId("header-view-buttons")).toBeVisible()

  for (const width of [700, 1600]) {
    await window.setViewportSize({ width, height: 800 })
    await expect(window.getByTestId("view-rail")).toHaveCount(0)
  }
})

test("PR chip opens the PR view and a second click focuses it instead of duplicating", async ({ launchApp }) => {
  const { window } = await launchApp({
    configured: true,
    withRepo: true,
    sessions: (context) => [{ ...session, prNumber: 482, worktreePath: context.repoPath }]
  })
  await window.getByTestId("session-row-s_view_launcher").click()
  const chip = window.getByTestId("header-link-pr")
  await expect(chip).toHaveText("PR #482")
  await chip.click()
  await expect(window.getByTestId("editor-tab-view-checks")).toHaveCount(1)
  await chip.click()
  await expect(window.getByTestId("editor-tab-view-checks")).toHaveCount(1)
})

test("reordering a pinned view from the overflow menu changes the header order live", async ({ launchApp }) => {
  const { window } = await launch(launchApp, ["changes", "checks", "terminal"])
  await window.getByTestId("session-row-s_view_launcher").click()

  const buttons = window.getByTestId("header-view-buttons")
  await expect(buttons.locator('[data-testid^="header-view-"]')).toHaveText(["Changes", "Checks", "Terminal"])

  await window.getByTestId("view-overflow-trigger").click()
  await window.getByTestId("move-checks-up").click()

  await expect(buttons.locator('[data-testid^="header-view-"]')).toHaveText(["Checks", "Changes", "Terminal"])
})

test("⌘K → Open view… opens the chosen view and leaves one tab on repeat", async ({ launchApp }) => {
  const { window } = await launch(launchApp)
  await window.getByTestId("session-row-s_view_launcher").click()
  for (let attempt = 0; attempt < 2; attempt++) {
    await window.keyboard.press("Meta+k")
    await window.getByTestId("palette-item-view:checks").click()
    await expect(window.getByTestId("command-palette")).toBeHidden()
    await expect(window.getByTestId("editor-tab-view-checks")).toHaveCount(1)
  }
})

test("a session with a PR shows Checks a/b in the header and ⌘⇧P opens it without duplicating", async ({ launchApp }) => {
  const { window } = await launchApp({
    configured: true,
    withRepo: true,
    sessions: (context) => [
      { ...session, prNumber: 482, githubInstallationId: "101", githubRepositoryId: "301", worktreePath: context.repoPath }
    ],
    githubApp: {
      connected: true,
      userLogin: "e2e-user",
      prs: [{
        number: 482,
        title: "Refactor auth flow",
        headRefName: "chore/refactor",
        baseRefName: "main",
        author: { login: "e2e-user" },
        additions: 1,
        deletions: 0,
        checks: [
          { name: "lint", conclusion: "success" },
          { name: "unit", conclusion: "success" },
          { name: "e2e", conclusion: "failure" }
        ]
      }]
    }
  })
  await window.getByTestId("session-row-s_view_launcher").click()
  await expect(window.getByTestId("header-view-checks")).toHaveText("Checks2/3")

  for (let attempt = 0; attempt < 2; attempt++) {
    await window.keyboard.press("Meta+Shift+p")
    await expect(window.getByTestId("editor-tab-view-checks")).toHaveCount(1)
  }
})
