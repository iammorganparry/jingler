import type { Page } from "@playwright/test"
import { expect } from "./fixtures.js"

/**
 * Show the Pull Request view's details rail. In a narrow group the rail (merge
 * box, checks, adversarial review) floats behind the "Pull request details"
 * toggle; in a wide one it is docked and there is nothing to open.
 */
export const showPullRequestDetails = async (window: Page): Promise<void> => {
  const toggle = window.getByRole("button", { name: "Pull request details", exact: true })
  const floating = await toggle.waitFor({ state: "visible", timeout: 5_000 }).then(() => true, () => false)
  if (!floating) return
  await toggle.click()
  await expect(
    window.getByRole("button", { name: "Close pull request details", exact: true })
  ).toBeVisible()
}
