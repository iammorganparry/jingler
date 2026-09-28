import type { Locator, Page } from "@playwright/test"
import { expect } from "./fixtures.js"

/**
 * The repository tree lives in the sidebar's Explorer tab (the Files view no
 * longer carries its own tree toggle). Switch the sidebar to it if needed and
 * return the visible tree.
 */
export const explorerTree = async (window: Page): Promise<Locator> => {
  const tree = window
    .locator('[data-jingler-pierre-file-tree][aria-label="Repository files"]')
    .filter({ visible: true })
    .first()
  if (!(await tree.isVisible())) {
    await window.getByRole("tab", { name: "Explorer", exact: true }).click()
  }
  await expect(tree).toBeVisible()
  return tree
}

/**
 * Review one changed file the way the app offers it now: the Changes rail
 * button filters the Explorer to changed files, and a file opens in Files on
 * its review diff. Returns that diff.
 */
export const openChangedFile = async (window: Page, path: string): Promise<Locator> => {
  await window.getByRole("button", { name: "Changes" }).first().click()
  const explorer = window.getByTestId("changed-files-explorer")
  await expect(explorer).toBeVisible({ timeout: 30_000 })
  const item = explorer.locator(`[role="treeitem"][data-item-path="${path}"]`)
  const diff = window.getByTestId("review-file-diff")
  // The changed-files tree is virtualized; retry a click it swallows mid-render.
  await expect(async () => {
    await item.click()
    await expect(diff).toBeVisible({ timeout: 2_000 })
  }).toPass({ timeout: 30_000 })
  return diff
}
