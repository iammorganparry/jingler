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
  await expect(window.getByRole("dialog", { name: "Pull request details" })).toBeVisible()
}

/** Open a session's PR via the `PRs · N` chip (shown instead of the `pr` link once a session has several PRs). */
export const openSessionPr = async (window: Page, prNumber: number): Promise<void> => {
  await window.getByTestId("session-prs-chip").click()
  await window.getByTestId(`session-prs-chip-row-${prNumber}`).click()
}
