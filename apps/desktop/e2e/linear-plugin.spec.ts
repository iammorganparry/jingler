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
test.skip("configures Linear, creates a session from ENG-123, comments, and persists across restart", async ({
  launchApp
}) => {
  const linear = await startFakeLinearServer()
  try {
    const first = await launchApp({
      configured: true,
      withRepo: true,
      githubApp: { connected: true, userLogin: "e2e-user", issues: [] },
      e2eEnv: { JINGLER_LINEAR_API_URL: linear.url }
    })

    await configureLinear(first.window)
    await first.window.getByTestId("new-session").click()
    await first.window.getByRole("tab", { name: "From issue" }).click()
    await first.window.getByLabel("Issue provider").click()
    await first.window.getByRole("option", { name: "Linear", exact: true }).click()
    await expect.poll(() => linear.authorizations).toContain(API_KEY)
    await expect(first.window.getByText("Retry failed payments", { exact: true })).toBeVisible({
      timeout: 20_000
    })
    await first.window.getByText("Retry failed payments", { exact: true }).click()
    await first.window.getByRole("button", { name: "Start on ENG-123" }).click()
    await first.window.getByRole("button", { name: "Create session" }).click()

    const createdRow = sessionRow(first.window, "Retry failed payments")
    await expect(createdRow.getByLabel("Linked issue ENG-123")).toBeVisible()
    await openLinearIssueTab(first.window)

    await expect(first.window.getByRole("heading", { name: "Retry failed payments" })).toBeVisible()
    await expect(
      first.window
        .getByTestId("linear-issue-body")
        .getByText("Retry a failed payment after refreshing its token.")
    ).toBeVisible()
    await expect(first.window.getByText("In Progress", { exact: true })).toBeVisible()
    await expect(first.window.getByText("Payments", { exact: true })).toBeVisible()
    await expect(first.window.getByText("Cycle 42", { exact: true })).toBeVisible()
    await expect(first.window.getByText("The retry should preserve idempotency.")).toBeVisible()

    await first.window.getByLabel("Add a comment").fill("Verified through the Jingler Linear plugin.")
    await first.window.getByRole("button", { name: "Comment", exact: true }).click()
    await expect(first.window.getByText("Verified through the Jingler Linear plugin.")).toBeVisible({
      timeout: 20_000
    })
    expect(linear.operations).toContain("commentCreate")
    expect(linear.authorizations).toContain(API_KEY)

    await first.app.close()
    const restarted = await launchApp({
      configured: true,
      withRepo: true,
      home: first.home,
      reposDir: first.reposDir,
      githubServer: first.githubServer,
      githubApp: { connected: true, userLogin: "e2e-user", issues: [] },
      e2eEnv: { JINGLER_LINEAR_API_URL: linear.url }
    })

    const restartedRow = sessionRow(restarted.window, "Retry failed payments")
    await expect(restartedRow.getByLabel("Linked issue ENG-123")).toBeVisible()
    await restartedRow.click()
    await openLinearIssueTab(restarted.window)
    await expect(
      restarted.window.getByText("Verified through the Jingler Linear plugin.")
    ).toBeVisible({ timeout: 20_000 })

    await restarted.window.getByRole("button", { name: "Unlink", exact: true }).click()
    await expect(restartedRow.getByLabel("Linked issue ENG-123")).toHaveCount(0)
    // Linear deliberately owns unlinked sessions so this same tab remains the
    // place to link or create the next issue; only the badge/detail ownership clears.
    await expect(restarted.window.getByRole("button", { name: "Issue", exact: true })).toBeVisible()
    await expect(restarted.window.getByRole("heading", { name: "Link an existing issue" })).toBeVisible()

    const sessions = JSON.parse(
      readFileSync(join(first.home, "jingler", "sessions.json"), "utf8")
    ) as ReadonlyArray<{ readonly linkedIssue?: unknown }>
    expect(sessions[0]?.linkedIssue).toBeUndefined()
  } finally {
    await linear.close()
  }
})

// biome-ignore lint/complexity/noExcessiveLinesPerFunction: linking then creating proves both mutations against one stateful fake
test.skip("links an existing Linear issue and creates a new one from session Issue tabs", async ({
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
    await launched.window
      .getByPlaceholder("Leave blank for agent naming")
      .fill("Manage Linear issues")
    await launched.window.getByRole("button", { name: "Create", exact: true }).click()
    const linkRow = sessionRow(launched.window, "Manage Linear issues")
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
