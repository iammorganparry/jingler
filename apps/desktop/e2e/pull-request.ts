import type { Page } from "@playwright/test"
import { expect } from "./fixtures.js"

/**
 * Show the Pull Request view's details rail. Beside the chat the PR pane is
 * narrow, so the rail (merge box, checks, adversarial review) floats behind the
 * "Pull request details" toggle rather than crushing the timeline.
 */
export const showPullRequestDetails = async (window: Page): Promise<void> => {
  const toggle = window.getByRole("button", { name: "Pull request details", exact: true })
  await expect(toggle).toBeVisible({ timeout: 20_000 })
  await toggle.click()
  await expect(
    window.getByRole("button", { name: "Close pull request details", exact: true })
  ).toBeVisible()
}
