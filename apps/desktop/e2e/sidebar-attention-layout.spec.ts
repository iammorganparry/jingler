import { appShell, expect, test } from "./fixtures.js"
import { explorerTree } from "./explorer.js"
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
  const tree = await explorerTree(window)
  await tree.locator('[role="treeitem"][data-item-path="README.md"]').click()

  // A file opens in the content group while chat stays visible beside it.
  const groups = window.getByTestId("editor-group")
  await expect(groups).toHaveCount(2)
  await expect(window.getByTestId("editor-tab-file-README.md")).toBeVisible()
  await expect(window.getByPlaceholder("Message the agent…")).toBeVisible()
  await expect(window.getByRole("region", { name: "Repository browser" })).toHaveCount(0)

  await window.setViewportSize({ width: 900, height: 700 })
  await window.waitForTimeout(120)
  // Below 1100px the chat lane folds into an overlay drawer behind the Ask pill;
  // the file group stays open and chat returns on demand.
  await expect(groups).toHaveCount(1)
  await expect(window.getByTestId("editor-tab-file-README.md")).toBeVisible()
  await window.getByRole("button", { name: "Show chat lane" }).click()
  await expect(window.getByPlaceholder("Message the agent…")).toBeVisible()
})

test("a long branch name truncates while the status word and diff stat stay on one line", async ({
  launchApp
}) => {
  const { window } = await launchApp({
    configured: true,
    isolateSystemHome: true,
    withRepo: true,
    sessions: [
      {
        id: "s_long_branch",
        repo: "widget",
        branch: "jingler/a-very-long-branch-name-that-cannot-possibly-fit-in-the-sidebar-row-at-any-width",
        title: "Long branch session",
        status: "running",
        diff: { added: 1234, removed: 567 },
        prNumber: 4821,
        costUsd: 0,
        tokens: 0,
        updatedAt: "2026-08-07T12:00:00.000Z",
        mode: "accept-edits"
      }
    ]
  })

  const row = window.getByTestId("session-row-s_long_branch")
  await expect(row).toBeVisible()

  const status = row.locator("span.tabular-nums.font-medium").first()
  const diffStat = row.locator("span.inline-flex.font-mono.tabular-nums").first()
  const branch = row.locator("div.font-mono > span.truncate").first()

  // The branch is the only thing that gives way.
  // Polled: per-project filters load after first paint, so the row can be measured mid-layout.
  await expect.poll(() => branch.evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(true)

  // The status word is a single line (not wrapped to a second one).
  const statusBox = await status.boundingBox()
  expect(statusBox?.height ?? 99).toBeLessThan(20)

  // +added and −removed share a line, and the whole stat is a single line.
  const tops = await diffStat.locator("span").evaluateAll((els) =>
    els.map((el) => el.getBoundingClientRect().top)
  )
  expect(tops).toHaveLength(2)
  expect(Math.abs(tops[0]! - tops[1]!)).toBeLessThanOrEqual(2)
  const statBox = await diffStat.boundingBox()
  expect(statBox?.height ?? 99).toBeLessThan(20)
})

test("the filter/sort menu and a row context menu are fully keyboard operable", async ({
  launchApp
}) => {
  const { window } = await launchApp({
    configured: true,
    isolateSystemHome: true,
    withRepo: true,
    sessions
  })
  await expect(appShell(window)).toBeVisible()

  // Open the filter menu from the keyboard: End jumps to the last axis row, Sort by.
  await window.getByTestId("session-filter-menu").focus()
  await window.keyboard.press("Enter")
  await expect(window.getByRole("menuitem", { name: /^Status/ })).toBeVisible()
  await window.keyboard.press("End")
  await expect(window.getByRole("menuitem", { name: /^Sort by/ })).toBeFocused()
  await window.keyboard.press("ArrowRight")
  await expect(window.getByRole("menuitem", { name: /^Recency/ })).toBeFocused()
  await window.keyboard.press("ArrowDown")
  await expect(window.getByRole("menuitem", { name: /^Name/ })).toBeFocused()
  await window.keyboard.press("Enter")
  await expect(window.getByRole("menu")).toHaveCount(0)

  // The choice shows on the closed row and persists under this project's key.
  await window.getByTestId("session-filter-menu").focus()
  await window.keyboard.press("Enter")
  await expect(window.getByRole("menuitem", { name: /^Sort by\s*Name/ })).toBeVisible()
  await window.keyboard.press("Escape")
  const stored = await window.evaluate(() =>
    Object.keys(localStorage)
      .filter((key) => key.startsWith("sb.sidebar.filters.v2."))
      .map((key) => JSON.parse(localStorage.getItem(key) ?? "{}").sortBy)
  )
  expect(stored).toContain("name")

  // A row's context menu opens with the keyboard and Rename is first.
  const row = window.getByTestId("session-row-s_running")
  await row.focus()
  await window.keyboard.press("Shift+F10")
  await expect(window.getByRole("menuitem", { name: "Rename" })).toBeFocused()
  await expect(window.getByRole("menuitem", { name: "Copy branch" })).toBeVisible()
  await expect(window.getByRole("menuitem", { name: "Archive" })).toBeVisible()
  await window.keyboard.press("Enter")
  await window.keyboard.type("Renamed from the keyboard")
  await window.keyboard.press("Enter")
  await expect(window.getByTestId("session-row-s_running")).toContainText(
    "Renamed from the keyboard"
  )
})
