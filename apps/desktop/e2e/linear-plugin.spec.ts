import { readFileSync } from "node:fs"
import { join } from "node:path"
import type { Page } from "@playwright/test"
import { addProject, appShell, createWorkspace, expect, sessionRow, test } from "./fixtures.js"
import { startFakeLinearServer } from "./fake-linear.js"
const API_KEY = "lin_api_e2e_linear_plugin"
const LINKED_LINEAR_ISSUE = /Linked issue ENG-/
const LINEAR_IDENTIFIER = /^ENG-/
const LINEAR_SOURCE_NAME = /^Linear issue/
const NEW_SESSION_SOURCES = ["New task", "Existing branch", "Pull request", "GitHub issue", "Linear issue"] as const

test("shows every new-session source and starts from a Linear issue", async ({
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
    await addProject(launched.window, launched.repoPath)

    await launched.window.getByRole("button", { name: "Session source" }).click()
    await Promise.all(
      NEW_SESSION_SOURCES.map((label) =>
        expect(launched.window.getByRole("option", { name: new RegExp(label) })).toBeVisible()
      )
    )

    const linearSource = launched.window.getByRole("option", { name: LINEAR_SOURCE_NAME })
    await expect(linearSource.locator('[data-linear-mark="true"]')).toBeVisible()
    await linearSource.click()
    await expect(launched.window.getByRole("heading", { name: "Linear issues" })).toBeVisible()
    const issue = launched.window.getByRole("button", { name: /Document retry policy/ })
    await expect(issue).toBeVisible({ timeout: 20_000 })
    await expect(issue.locator("img")).toBeVisible()
    await issue.click()
    await expect(launched.window.getByPlaceholder(/Message the agent/)).toHaveValue(/Document retry policy/)
    await launched.window.getByPlaceholder(/Message the agent/).press("Enter")
    await expect(sessionRow(launched.window, "Document retry policy")).toBeVisible({ timeout: 20_000 })

    // SAFETY: The desktop session store owns this file and validates its schema
    // before writing it; this test reads the same persisted representation.
    const sessions = JSON.parse(
      readFileSync(join(launched.home, "jingler", "sessions.json"), "utf8")
    ) as ReadonlyArray<{
      readonly linkedIssues?: ReadonlyArray<{ readonly providerId: string; readonly identifier: string }>
    }>
    expect(sessions[0]?.linkedIssues).toEqual(
      expect.arrayContaining([expect.objectContaining({ providerId: "linear", identifier: "ENG-124" })])
    )
  } finally {
    await linear.close()
  }
})

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

test("selects and removes one of several linked Linear issues from the right rail", async ({
  launchApp
}) => {
  const linear = await startFakeLinearServer()
  try {
    const launched = await launchApp({
      configured: true,
      withRepo: true,
      sessions: ({ repoPath }) => [{
        id: "linear-multi",
        repo: "widget",
        branch: "main",
        title: "Linear multi-issue session",
        status: "idle",
        diff: { added: 0, removed: 0 },
        prNumber: null,
        costUsd: 0,
        tokens: 0,
        updatedAt: "2026-08-10T12:00:00.000Z",
        worktreePath: repoPath,
        repoPath,
        linkedIssues: [
          {
            providerId: "linear",
            id: "issue-uuid-123",
            identifier: "ENG-123",
            title: "Retry failed payments",
            url: "https://linear.app/acme/issue/ENG-123/retry-failed-payments",
            labels: []
          },
          {
            providerId: "linear",
            id: "issue-uuid-124",
            identifier: "ENG-124",
            title: "Document retry policy",
            url: "https://linear.app/acme/issue/ENG-124/document-retry-policy",
            labels: []
          }
        ],
        selectedIssue: { providerId: "linear", id: "issue-uuid-123" }
      }],
      e2eEnv: { JINGLER_LINEAR_API_URL: linear.url }
    })
    await configureLinear(launched.window)

    await launched.window.getByRole("button", { name: "Select linked Linear issue" }).click()
    await launched.window.getByRole("option", { name: /ENG-124 Document retry policy/ }).click()
    await expect(launched.window.getByRole("heading", { name: "Document retry policy" })).toBeVisible({
      timeout: 20_000
    })

    await launched.window.getByRole("button", { name: "Unlink", exact: true }).click()
    await expect(launched.window.getByRole("heading", { name: "Retry failed payments" })).toBeVisible({
      timeout: 20_000
    })

    // SAFETY: The desktop session store owns and schema-validates this file;
    // this test only inspects the persisted linked-issue fields.
    const sessions = JSON.parse(
      readFileSync(join(launched.home, "jingler", "sessions.json"), "utf8")
    ) as ReadonlyArray<{
      readonly linkedIssues?: ReadonlyArray<{ readonly id: string }>
      readonly selectedIssue?: { readonly id: string }
    }>
    expect(sessions[0]?.linkedIssues?.map(({ id }) => id)).toEqual(["issue-uuid-123"])
    expect(sessions[0]?.selectedIssue?.id).toBe("issue-uuid-123")
  } finally {
    await linear.close()
  }
})

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

    await createWorkspace(launched.window, "", "direct", launched.repoPath)
    const linkRow = launched.window.locator('[data-testid^="session-row-"]').first()
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

    // SAFETY: The desktop session store owns this file and validates its schema
    // before writing it; this test reads the corresponding persisted fields.
    const sessions = JSON.parse(
      readFileSync(join(launched.home, "jingler", "sessions.json"), "utf8")
    ) as ReadonlyArray<{
      readonly id: string
      readonly linkedIssues?: ReadonlyArray<{ readonly providerId: string; readonly identifier: string }>
    }>
    expect(sessions).toHaveLength(1)
    expect(sessions[0]?.linkedIssues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          providerId: "linear",
          identifier: expect.stringMatching(LINEAR_IDENTIFIER)
        })
      ])
    )
  } finally {
    await linear.close()
  }
})
