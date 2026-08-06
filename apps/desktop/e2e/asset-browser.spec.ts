import { execFileSync } from "node:child_process"
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { appShell, expect, test } from "./fixtures.js"
import type { SeedSession } from "./fixtures.js"

const REPOSITORY_FILES = 1_200
const SOURCE_LINES = 5_000
const PIERRE_HOST_CLASS = /jingler-pierre-host/

const seeded = (worktreePath: string): SeedSession => ({
  id: "s_large_assets",
  repo: "widget",
  branch: "jingler/large-assets",
  title: "Large asset browser",
  status: "idle",
  cli: "claude",
  diff: { added: 0, removed: 0 },
  prNumber: null,
  costUsd: 0,
  tokens: 0,
  updatedAt: "2026-08-05T00:00:00.000Z",
  worktreePath
})

const transcript = [
  {
    id: "large-assets",
    role: "assistant",
    streaming: false,
    createdAt: "2026-08-05T00:00:00.000Z",
    parts: [
      {
        _tag: "Text",
        text: "Inspect the generated source in `src/huge.ts`."
      }
    ]
  }
]

test("keeps a large repository and source file windowed while navigating the persistent tree", async ({
  launchApp
}) => {
  const { window } = await launchApp({
    configured: true,
    withRepo: true,
    sessions: ({ repoPath }) => [seeded(repoPath)],
    transcripts: { s_large_assets: transcript },
    seed: ({ repoPath }) => {
      mkdirSync(join(repoPath, "src"), { recursive: true })
      mkdirSync(join(repoPath, "generated"), { recursive: true })
      writeFileSync(
        join(repoPath, "src", "huge.ts"),
        `${Array.from(
          { length: SOURCE_LINES },
          (_, index) => `export const value_${String(index).padStart(4, "0")} = ${index}`
        ).join("\n")}\n`
      )
      for (let index = 0; index < REPOSITORY_FILES; index += 1) {
        writeFileSync(
          join(repoPath, "generated", `file-${String(index).padStart(4, "0")}.ts`),
          `export const generated = ${index}\n`
        )
      }
      execFileSync("git", ["add", "-A"], { cwd: repoPath })
      execFileSync("git", ["commit", "-m", "large assets", "--no-gpg-sign"], {
        cwd: repoPath
      })
    }
  })

  await expect(appShell(window)).toBeVisible()
  await window.getByTitle("Open src/huge.ts").click()
  await expect(window.getByRole("button", { name: "Files", exact: true })).toHaveAttribute(
    "aria-current",
    "page"
  )
  await expect(window.getByText("export const value_0000 = 0", { exact: true })).toBeVisible({
    timeout: 30_000
  })

  const mountedSourceLines = await window
    .locator('diffs-container [data-line][data-line-index]')
    .count()
  expect(mountedSourceLines).toBeGreaterThan(0)
  expect(mountedSourceLines).toBeLessThan(SOURCE_LINES)

  // Keep a stable host locator while virtualization replaces the first line.
  // A hasText filter tied to line 1 stops resolving as soon as PageDown unmounts
  // that line, turning a successful scroll into a locator timeout.
  const sourceSkin = window.getByRole("region", { name: "src/huge.ts editor" })
  await expect(sourceSkin).toHaveClass(PIERRE_HOST_CLASS)
  const sourceMetrics = await sourceSkin.locator("diffs-container").evaluate((element) => {
    const root = element.shadowRoot
    if (root === null) throw new Error("Pierre editor shadow root is missing")
    const header = root.querySelector<HTMLElement>('[data-diffs-header="default"]')
    const line = root.querySelector<HTMLElement>("[data-line]")
    const gutter = root.querySelector<HTMLElement>("[data-column-number]")
    if (header === null || line === null || gutter === null) {
      throw new Error("Pierre editor visual-contract node is missing")
    }
    return {
      fontSize: Math.round(Number.parseFloat(getComputedStyle(line).fontSize)),
      rowHeight: Math.round(line.getBoundingClientRect().height),
      headerHeight: Math.round(header.getBoundingClientRect().height),
      gutterWidth: Math.round(gutter.getBoundingClientRect().width)
    }
  })
  expect(sourceMetrics).toEqual({
    fontSize: 11,
    rowHeight: 21,
    headerHeight: 34,
    gutterWidth: 40
  })

  const sourceElements = sourceSkin.locator("*")
  const sourceScrollerIndex = await sourceElements.evaluateAll((elements) => {
    let bestIndex = -1
    let bestRange = 0
    for (const [index, element] of elements.entries()) {
      const range = element.scrollHeight - element.clientHeight
      const overflowY = getComputedStyle(element).overflowY
      if (range > bestRange && (overflowY === "auto" || overflowY === "scroll")) {
        bestIndex = index
        bestRange = range
      }
    }
    return bestIndex
  })
  expect(sourceScrollerIndex).toBeGreaterThanOrEqual(0)
  const sourceScroller = sourceElements.nth(sourceScrollerIndex)
  const sourceScrollMetrics = await sourceScroller.evaluate((element) => ({
    clientHeight: element.clientHeight,
    scrollHeight: element.scrollHeight,
    overflowY: getComputedStyle(element).overflowY
  }))
  expect(sourceScrollMetrics.scrollHeight).toBeGreaterThan(sourceScrollMetrics.clientHeight)
  expect(["auto", "scroll"]).toContain(sourceScrollMetrics.overflowY)
  await sourceScroller.evaluate((element) => element.scrollTo({ top: 0 }))
  const editor = window.getByRole("textbox", { name: "src/huge.ts" })
  await editor.focus()
  await editor.press("PageDown")
  await expect
    .poll(() => sourceScroller.evaluate((element) => element.scrollTop))
    .toBeGreaterThan(0)
  await sourceScroller.evaluate((element) => element.scrollTo({ top: element.scrollHeight }))
  await expect(window.getByText("export const value_4999 = 4999", { exact: true })).toBeVisible({
    timeout: 15_000
  })

  const tree = window.locator(
    '[data-jingler-pierre-file-tree][aria-label="Repository files"]'
  )
  const treeToggle = window.getByRole("button", {
    name: "Repository files",
    exact: true
  })
  if ((await treeToggle.count()) > 0 && (await treeToggle.getAttribute("aria-expanded")) !== "true") {
    await treeToggle.click()
  }
  await expect(tree).toBeVisible()
  await tree.evaluate((element) => element.setAttribute("data-s4-tree", "persistent"))

  const treeItems = tree.locator('[role="treeitem"]')
  await expect.poll(() => treeItems.count()).toBeGreaterThan(0)
  const mountedTreeItems = await treeItems.count()
  expect(mountedTreeItems).toBeGreaterThan(0)
  expect(mountedTreeItems).toBeLessThan(REPOSITORY_FILES)

  const firstMountedTreeItem = treeItems.first()
  await firstMountedTreeItem.focus()
  await firstMountedTreeItem.press("f")
  const search = tree.locator("[data-file-tree-search-input]")
  await expect(search).toBeVisible()
  await search.fill("file-1199.ts")
  await search.press("Enter")

  await expect(window.getByRole("textbox", { name: "generated/file-1199.ts" })).toBeVisible({
    timeout: 15_000
  })
  await expect(window.getByText("export const generated = 1199", { exact: true })).toBeVisible({
    timeout: 15_000
  })
  await expect(tree).toHaveAttribute("data-s4-tree", "persistent")
  // The constrained tree sheet closes after selection; the editor's accessible
  // name above is the observable selected-path contract after that close.
})

test("renders a changed file preview with the legacy Jingler diff skin on Pierre", async ({
  launchApp
}) => {
  const { window } = await launchApp({
    configured: true,
    withRepo: true,
    sessions: ({ repoPath }) => [
      {
        ...seeded(repoPath),
        id: "s_changed_preview",
        title: "Changed preview"
      }
    ],
    transcripts: {
      s_changed_preview: [
        {
          ...transcript[0],
          id: "changed-preview",
          parts: [{ _tag: "Text", text: "Inspect `src/session.ts`." }]
        }
      ]
    },
    seed: ({ repoPath }) => {
      mkdirSync(join(repoPath, "src"), { recursive: true })
      const path = join(repoPath, "src", "session.ts")
      writeFileSync(path, "export const session = createSession(cookie)\n")
      execFileSync("git", ["add", "-A"], { cwd: repoPath })
      execFileSync("git", ["commit", "-m", "seed changed preview", "--no-gpg-sign"], {
        cwd: repoPath
      })
      writeFileSync(path, "export const session = createSession(token)\n")
    }
  })

  await expect(appShell(window)).toBeVisible()
  await window.getByTitle("Open src/session.ts").click()
  // Files intentionally opens changed text in the editor instead of replacing
  // it with a read-only diff. The editor and diff surfaces share this skin.
  const preview = window.locator('[data-jingler-pierre-view="code-view"]')
  await expect(preview).toHaveClass(PIERRE_HOST_CLASS)
  await expect(preview.getByText("export const session = createSession(token)", { exact: true }))
    .toBeVisible({ timeout: 30_000 })

  const metrics = await preview.locator("diffs-container").evaluate((element) => {
    const root = element.shadowRoot
    if (root === null) throw new Error("Pierre changed-preview shadow root is missing")
    const line = root.querySelector<HTMLElement>("[data-line]")
    const gutter = root.querySelector<HTMLElement>("[data-column-number]")
    const header = root.querySelector<HTMLElement>('[data-diffs-header="default"]')
    if (line === null || gutter === null || header === null) {
      throw new Error("Pierre changed-preview visual contract is missing")
    }
    return {
      fontSize: Math.round(Number.parseFloat(getComputedStyle(line).fontSize)),
      rowHeight: Math.round(line.getBoundingClientRect().height),
      headerHeight: Math.round(header.getBoundingClientRect().height),
      gutterWidth: Math.round(gutter.getBoundingClientRect().width)
    }
  })
  expect(metrics).toMatchObject({
    fontSize: 11,
    rowHeight: 21,
    headerHeight: 34,
    gutterWidth: 40
  })
})
