import { writeFileSync } from "node:fs"
import { join } from "node:path"
import type { Page } from "@playwright/test"
import { appShell, expect, type SeedSession, test } from "./fixtures.js"

const dragTo = async (
  page: Page,
  sourceSelector: string,
  targetSelector: string,
  fraction: number
) => {
  await page.evaluate(
    ({ sourceSelector, targetSelector, fraction }) => {
      const source = document.querySelector(sourceSelector)
      const target = document.querySelector(targetSelector)
      if (!(source && target)) throw new Error(`missing drag node: ${sourceSelector} → ${targetSelector}`)
      const box = target.getBoundingClientRect()
      const dataTransfer = new DataTransfer()
      const init = {
        dataTransfer,
        bubbles: true,
        cancelable: true,
        clientX: box.left + box.width * fraction,
        clientY: box.top + box.height / 2
      }
      source.dispatchEvent(new DragEvent("dragstart", init))
      target.dispatchEvent(new DragEvent("dragover", init))
      target.dispatchEvent(new DragEvent("drop", init))
      source.dispatchEvent(new DragEvent("dragend", init))
    },
    { sourceSelector, targetSelector, fraction }
  )
}

const session = ({ repoPath }: { repoPath: string }): ReadonlyArray<SeedSession> => [{
  id: "s_tab_groups",
  repo: "widget",
  repoPath,
  branch: "main",
  title: "Grouped tabs",
  status: "idle",
  diff: { added: 0, removed: 0 },
  prNumber: null,
  costUsd: 0,
  tokens: 0,
  updatedAt: "2026-08-09T00:00:00.000Z",
  worktreePath: repoPath,
  workspaceMode: "direct",
  mode: "auto"
}]

test("large chat and file sets collapse into independent tab groups", async ({ launchApp }) => {
  const launched = await launchApp({
    configured: true,
    isolateSystemHome: true,
    withRepo: true,
    sessions: session,
    seed: ({ repoPath }) => {
      for (let index = 1; index <= 6; index += 1) {
        writeFileSync(join(repoPath, `file-${index}.ts`), `export const file${index} = true\n`)
      }
    }
  })
  const { window } = launched
  await expect(appShell(window)).toBeVisible()

  for (let index = 0; index < 3; index += 1) {
    await window.getByRole("button", { name: "New tab" }).click()
    await window.getByTestId("new-tab-option-chat").click()
  }
  await expect(window.getByTitle("4 open chats")).toBeVisible()

  await window.getByRole("button", { name: "Files", exact: true }).click()
  const tree = window.locator('[data-jingler-pierre-file-tree][aria-label="Repository files"]')
  const treeToggle = window.getByRole("button", { name: "Repository files", exact: true })
  if (!(await tree.isVisible())) await treeToggle.click()
  await expect(tree).toBeVisible()
  for (let index = 1; index <= 6; index += 1) {
    const path = `file-${index}.ts`
    if (!(await tree.isVisible())) await treeToggle.click()
    await tree.locator(`[role="treeitem"][data-item-path="${path}"]`).click()
    await expect(window.getByTestId(`file-tab-${path}`)).toBeVisible()
  }
  await expect(window.getByTitle("6 open files")).toBeVisible()

  await window.getByRole("button", { name: "Collapse chats group" }).click()
  await expect(window.getByTestId("chat-tab-chat-1")).toHaveCount(0)
  await expect(window.getByTestId("file-tab-file-6.ts")).toBeVisible()

  await window.getByRole("button", { name: "Collapse files group" }).click()
  await expect(window.getByTestId("file-tab-file-6.ts")).toHaveCount(0)
  await expect(window.getByRole("textbox", { name: "file-6.ts" })).toBeVisible()
  await expect(window.getByRole("button", { name: "Expand chats group" })).toBeVisible()
  await expect(window.getByRole("button", { name: "Expand files group" })).toBeVisible()
})

test("the + dropdown and cmd+t command menu share tab types and quick keys", async ({ launchApp }) => {
  const { window } = await launchApp({ configured: true, isolateSystemHome: true, withRepo: true, sessions: session })
  await expect(appShell(window)).toBeVisible()
  await expect(
    window.getByTestId("session-sidebar").getByRole("button", { name: "Search sessions and actions" })
  ).toBeVisible()
  await expect(window.getByTestId("title-bar").getByTestId("session-tab-bar")).toBeVisible()

  await window.getByRole("button", { name: "New tab" }).click()
  await expect(window.getByTestId("new-tab-option-browser")).toBeVisible()
  await expect(window.getByTestId("new-tab-option-terminal")).toBeVisible()
  await window.keyboard.press("Escape")

  await window.keyboard.press("Meta+t")
  await expect(window.getByTestId("new-tab-command-menu")).toBeVisible()
  await window.keyboard.press("4")
  await expect(window.getByTitle("1 open view")).toBeVisible()
  await expect(window.getByTestId("open-view-tab-terminal")).toBeVisible()
})

test("tabs split inside one pane of an outer session split", async ({ launchApp }) => {
  const { window } = await launchApp({
    configured: true,
    isolateSystemHome: true,
    withRepo: true,
    sessions: ({ repoPath }) => [
      ...session({ repoPath }),
      {
        ...session({ repoPath })[0]!,
        id: "s_second",
        title: "Second session",
        branch: "feature/second"
      }
    ]
  })
  await expect(appShell(window)).toBeVisible()

  await dragTo(window, '[data-testid="session-row-s_second"]', '[data-testid="split-pane-0"]', 0.96)
  await expect(window.getByTestId("split-view")).toHaveAttribute("data-panes", "2")

  const first = window.getByTestId("split-pane-0")
  await first.click({ position: { x: 20, y: 80 } })
  await window.getByRole("button", { name: "New tab" }).click()
  await window.getByTestId("new-tab-option-terminal").click()
  await expect(window.getByTestId("open-view-tab-terminal")).toBeVisible()

  await expect(first.getByTestId("surface-view")).toHaveAttribute("data-panes", "2")
  await window.evaluate(() =>
    window.dispatchEvent(new KeyboardEvent("keydown", {
      key: "!",
      code: "Digit1",
      ctrlKey: true,
      shiftKey: true,
      bubbles: true
    }))
  )
  await expect(first.getByTestId("surface-pane-0")).toHaveAttribute("data-focused", "true")
  await window.evaluate(() =>
    window.dispatchEvent(new KeyboardEvent("keydown", {
      key: "}",
      code: "BracketRight",
      ctrlKey: true,
      shiftKey: true,
      bubbles: true
    }))
  )
  await expect(first.getByTestId("surface-pane-1")).toHaveAttribute("data-focused", "true")
  await window.evaluate(() =>
    window.dispatchEvent(new KeyboardEvent("keydown", {
      key: "ArrowLeft",
      code: "ArrowLeft",
      ctrlKey: true,
      shiftKey: true,
      altKey: true,
      bubbles: true
    }))
  )
  await expect(first.getByTestId("surface-pane-0")).toHaveAttribute("data-surface", /terminal/)
  await window.getByRole("button", { name: "Move pane right" }).click()
  await expect(first.getByTestId("surface-pane-1")).toHaveAttribute("data-surface", /terminal/)
  await window.getByRole("button", { name: "Move pane left" }).click()
  await window.getByRole("button", { name: "Close pane" }).click()
  await expect(first.getByTestId("surface-view")).toHaveAttribute("data-panes", "1")
  await expect(window.getByTestId("open-view-tab-terminal")).toBeVisible()
  await expect(window.getByTestId("split-pane-1").getByTestId("surface-view")).toHaveAttribute(
    "data-panes",
    "1"
  )
})
