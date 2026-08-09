import { readFileSync } from "node:fs"
import { join } from "node:path"
import type { Page } from "@playwright/test"
import { appShell, expect, sessionRow, test } from "./fixtures.js"
import { startFakeLinearServer } from "./fake-linear.js"
const API_KEY = "lin_api_e2e_linear_plugin"
const LINKED_LINEAR_ISSUE = /Linked issue ENG-/
const LINEAR_IDENTIFIER = /^ENG-/

const openPluginSettings = async (window: Page): Promise<void> => {
  await expect(appShell(window)).toBeVisible()
  await window.getByRole("button", { name: "Account menu" }).click()
  await window.getByRole("menuitem", { name: "Settings" }).click()
  await window.getByRole("button", { name: "Plugins" }).click()
}

const configureLinear = async (window: Page): Promise<void> => {
  await openPluginSettings(window)
  const row = window.getByTestId("plugin-row-linear")
  await expect(row).toBeVisible({ timeout: 15_000 })
  await row.getByLabel("Personal API key").fill(API_KEY)
  await row.getByRole("button", { name: "Save" }).click()
  await expect(row.getByRole("button", { name: "Replace" })).toBeVisible()
  await expect(row).not.toContainText(API_KEY)
  await window.getByRole("button", { name: "Close settings" }).click()
}

const openLinearIssueTab = async (window: Page): Promise<void> => {
  const tab = window.getByRole("button", { name: "Issue", exact: true })
  await expect(tab).toBeVisible({ timeout: 15_000 })
  // biome-ignore lint/security/noSecrets: this is a stable CSS test hook, not a credential
  await expect(tab.locator('[data-plugin-asset-icon="ready"]')).toBeVisible({ timeout: 15_000 })
  const maskStyle = await tab
    .locator('[data-plugin-asset-icon="ready"] rect')
    .getAttribute("style")
  expect(maskStyle).toContain("jingler-plugin://linear/dist/assets/linear-mark.svg")
  await tab.click()
  await expect(window.getByTestId("linear-issue-body")).toBeVisible({ timeout: 15_000 })
}

// biome-ignore lint/complexity/noExcessiveLinesPerFunction: one restart-spanning user workflow is clearer than hidden setup phases
test("links an existing Linear issue and creates a new one from workspace Issue tabs", async ({
  launchApp
}) => {
  const linear = await startFakeLinearServer()
  try {
    const launched = await launchApp({
      configured: true,
      withRepo: true,
      e2eEnv: { JINGLER_LINEAR_API_URL: linear.url }
    })

    await configureLinear(launched.window)

    await launched.window.getByTestId("new-session").click()
    await expect(launched.window.getByRole("heading", { name: "New session" })).toBeVisible()
    await launched.window.getByRole("button", { name: "Checkout" }).click()
    await launched.window.getByRole("option", { name: "Local" }).click()
    await launched.window.getByRole("button", { name: "Create workspace", exact: true }).click()
    const linkRow = sessionRow(launched.window, "Untitled session")
    await expect(linkRow).toBeVisible()
    await openLinearIssueTab(launched.window)
    await expect(launched.window.getByRole("heading", { name: "Link an existing issue" })).toBeVisible({
      timeout: 20_000
    })
    await launched.window.getByLabel("Search Linear issues").fill("ENG-124")
    await launched.window.getByRole("button", { name: "Search", exact: true }).click()
    await expect(launched.window.getByText("Document retry policy", { exact: true })).toBeVisible()
    await launched.window.getByRole("button", { name: "Link ENG-124" }).click()
    await expect(linkRow.getByLabel("Linked issue ENG-124")).toBeVisible()
    await expect(launched.window.getByRole("heading", { name: "Document retry policy" })).toBeVisible()

    await launched.window.getByRole("button", { name: "Unlink", exact: true }).click()
    await expect(linkRow.getByLabel("Linked issue ENG-124")).toHaveCount(0)
    await expect(launched.window.getByRole("heading", { name: "Create an issue" })).toBeVisible({
      timeout: 20_000
    })
    const issueBody = launched.window.getByTestId("linear-issue-body")
    await issueBody.getByRole("textbox", { name: "Title" }).fill("Reconcile duplicate charges")
    await issueBody
      .getByLabel("Description")
      .fill("Reconcile duplicate payment charges without losing the audit trail.")
    await launched.window.getByRole("button", { name: "Create and link" }).click()

    await expect(launched.window.getByRole("heading", { name: "Reconcile duplicate charges" })).toBeVisible({
      timeout: 20_000
    })
    await expect(linkRow.getByLabel(LINKED_LINEAR_ISSUE)).toBeVisible()
    expect(linear.operations).toContain("issueCreate")

    const sessions = JSON.parse(
      readFileSync(join(launched.home, "jingler", "sessions.json"), "utf8")
    ) as ReadonlyArray<{
      readonly id: string
      readonly linkedIssue?: { readonly providerId: string; readonly identifier: string }
    }>
    expect(sessions).toHaveLength(1)
    expect(sessions[0]?.linkedIssue).toMatchObject({
      providerId: "linear",
      identifier: expect.stringMatching(LINEAR_IDENTIFIER)
    })
  } finally {
    await linear.close()
  }
})
