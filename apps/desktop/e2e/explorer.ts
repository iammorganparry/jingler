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
