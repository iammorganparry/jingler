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
  await expect(window.locator('[data-testid^="header-view-"]:not([data-testid="header-view-buttons"])')).toHaveCount(1)

  await window.getByTestId("view-overflow-trigger").click()
  const refused = window.getByTestId("pin-terminal")
  await expect(refused).toHaveAttribute("aria-disabled", "true")
  await expect(refused).toBeVisible()
  await refused.hover()
  await expect(window.getByText("Header is full (5 pinned). Unpin a view first.").first()).toBeVisible()

  await refused.click({ force: true })
  await expect(window.locator('[data-testid^="header-view-"]:not([data-testid="header-view-buttons"])')).toHaveCount(1)
})
