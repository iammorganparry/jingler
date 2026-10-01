import { appShell, expect, test } from "./fixtures.js"
import type { SeedSession } from "./fixtures.js"

const sessions = ({ repoPath }: { repoPath: string }): ReadonlyArray<SeedSession> => [
  {
    id: "s_idle",
    repo: "widget",
    branch: "jingler/idle",
    title: "Newest idle chat",
    status: "idle",
    diff: { added: 0, removed: 0 },
    prNumber: null,
    costUsd: 0,
    tokens: 0,
    updatedAt: "2026-08-07T12:00:00.000Z",
    worktreePath: repoPath,
    mode: "accept-edits"
  },
  {
    id: "s_running",
    repo: "widget",
    branch: "jingler/running",
    title: "Agent still running",
    status: "running",
    diff: { added: 0, removed: 0 },
    prNumber: null,
    costUsd: 0,
    tokens: 0,
    updatedAt: "2026-08-07T11:00:00.000Z",
    worktreePath: repoPath,
    mode: "accept-edits"
  },
  {
    id: "s_needs_input",
    repo: "widget",
    branch: "jingler/needs-input",
    title: "Waiting for a decision",
    status: "needs-input",
    diff: { added: 0, removed: 0 },
    prNumber: null,
    costUsd: 0,
    tokens: 0,
    updatedAt: "2026-08-07T10:00:00.000Z",
    worktreePath: repoPath,
    mode: "accept-edits"
  }
]

test("groups chats by attention and opens session views in a responsive two-thirds pane", async ({
  launchApp
}) => {
  const { window } = await launchApp({
    configured: true,
    isolateSystemHome: true,
    withRepo: true,
    sessions
  })

  await expect(appShell(window)).toBeVisible()
  await window.setViewportSize({ width: 1500, height: 860 })

  await expect(window.getByText("Needs Input", { exact: true }).first()).toBeVisible()
  await expect(window.getByText("Running", { exact: true }).first()).toBeVisible()
  await expect(window.getByText("Idle", { exact: true }).first()).toBeVisible()

  const rowIds = await window
    .locator("[data-testid^='session-row-']")
    .evaluateAll((rows) => rows.map((row) => row.getAttribute("data-testid")))
  expect(rowIds).toEqual([
    "session-row-s_needs_input",
    "session-row-s_running",
    "session-row-s_idle"
  ])

  await window.getByTestId("session-row-s_needs_input").click()
  await window.getByRole("button", { name: "Files", exact: true }).click()
  await window.getByRole("tab", { name: "Explorer", exact: true }).click()

  // Files opens as a tab in the focused group, beside the chat tab.
  const groups = window.getByTestId("editor-group")
  await expect(groups).toHaveCount(1)
  await expect(window.getByTestId("editor-tab-view-files")).toBeVisible()
  const tree = window.getByRole("region", { name: "Repository files" })
  await expect(tree).toBeVisible()
  await expect(window.getByRole("region", { name: "Repository browser" })).toHaveCount(0)

  await window.setViewportSize({ width: 900, height: 700 })
  await window.waitForTimeout(120)
  // Below the rail threshold the sidebar (and its Explorer) folds away; the
  // editor keeps its single group with Files still open.
  await expect(groups).toHaveCount(1)
  await expect(window.getByTestId("editor-tab-view-files")).toBeVisible()
})
