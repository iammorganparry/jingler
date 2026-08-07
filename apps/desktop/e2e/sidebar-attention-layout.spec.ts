import { appShell, expect, test } from "./fixtures.js"
import type { SeedSession } from "./fixtures.js"

const sessions = ({ repoPath }: { repoPath: string }): ReadonlyArray<SeedSession> => [
  {
    id: "s_idle",
    repo: "widget",
    branch: "jingler/idle",
    title: "Newest idle chat",
    status: "idle",
    cli: "claude",
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
    cli: "claude",
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
    cli: "claude",
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

  const split = window.getByTestId("session-auxiliary-split")
  const panel = window.getByTestId("session-auxiliary-panel")
  await expect(split).toBeVisible()
  await expect(window.getByTestId("session-auxiliary-chat")).toBeVisible()
  await expect(panel).toBeVisible()
  const [splitBox, panelBox] = await Promise.all([split.boundingBox(), panel.boundingBox()])
  expect(splitBox).not.toBeNull()
  expect(panelBox).not.toBeNull()
  expect(panelBox!.width / splitBox!.width).toBeGreaterThan(0.62)
  expect(panelBox!.width / splitBox!.width).toBeLessThan(0.7)

  await window.setViewportSize({ width: 900, height: 700 })
  await window.waitForTimeout(120)
  await expect(split).toHaveCount(0)
  await expect(window.getByRole("region", { name: "Repository files" })).toBeVisible()
})
