import type { Page } from "@playwright/test"
import { expect } from "./fixtures.js"

/**
 * Open a session view (built-in id like `files`, or a plugin tab id like
 * `e2e-tab.main`). Pinned views are header buttons; the rest live in the
 * "More views" overflow menu.
 */
export const openView = async (window: Page, viewId: string, timeout = 15_000): Promise<void> => {
  const pinned = window.getByTestId(`header-view-${viewId}`)
  if (await pinned.isVisible()) return pinned.click()
  await window.getByTestId("view-overflow-trigger").click({ timeout })
  await window.getByTestId(`open-${viewId}`).click({ timeout })
}

/** Assert the overflow menu does (or does not) list a view, then close the menu. */
export const expectViewListed = async (
  window: Page,
  viewId: string,
  listed: boolean,
  timeout = 15_000
): Promise<void> => {
  await window.getByTestId("view-overflow-trigger").click({ timeout })
  await expect(window.getByTestId(`open-${viewId}`)).toHaveCount(listed ? 1 : 0, { timeout })
  await window.keyboard.press("Escape")
}
