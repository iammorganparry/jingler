import { writeFileSync } from "node:fs"
import { join } from "node:path"
import type { Page } from "@playwright/test"
import { appShell, expect, type SeedSession, test } from "./fixtures.js"

/**
 * Editor groups, driven through the real built app: chats, files and views are
 * tabs, groups split in both directions, the sidebar tree lists each session's
 * open items, and every session keeps its own layout.
 *
 * Drags are dispatched synthetically against a real DataTransfer, so they run
 * the real handlers and the session-scoped MIME check.
 */

const dragTo = async (page: Page, sourceSelector: string, targetSelector: string, x: number, y = 0.5) => {
  await page.evaluate(
    ({ sourceSelector, targetSelector, x, y }) => {
      const source = document.querySelector(sourceSelector)
      const target = document.querySelector(targetSelector)
      if (!(source && target)) throw new Error(`missing drag node: ${sourceSelector} → ${targetSelector}`)
      const box = target.getBoundingClientRect()
      const dataTransfer = new DataTransfer()
      const init = {
        dataTransfer,
        bubbles: true,
        cancelable: true,
        clientX: box.left + box.width * x,
        clientY: box.top + box.height * y
      }
      source.dispatchEvent(new DragEvent("dragstart", init))
      target.dispatchEvent(new DragEvent("dragover", init))
      target.dispatchEvent(new DragEvent("drop", init))
      source.dispatchEvent(new DragEvent("dragend", init))
    },
    { sourceSelector, targetSelector, x, y }
  )
}

const sessions = ({ repoPath }: { repoPath: string }): ReadonlyArray<SeedSession> => {
  const base = {
    repo: "widget",
    repoPath,
    status: "idle" as const,
    diff: { added: 0, removed: 0 },
    prNumber: null,
    costUsd: 0,
    tokens: 0,
    updatedAt: "2026-10-01T00:00:00.000Z",
    worktreePath: repoPath,
    workspaceMode: "direct" as const,
    mode: "auto" as const
  }
  return [
    {
      ...base,
      id: "s_alpha",
      title: "Alpha session",
      branch: "main",
      chats: [
        { id: "c_main", title: "Main chat", createdAt: base.updatedAt, updatedAt: base.updatedAt },
        { id: "c_side", title: "Side chat", createdAt: base.updatedAt, updatedAt: base.updatedAt }
      ],
      activeChatId: "c_main"
    },
    { ...base, id: "s_beta", title: "Beta session", branch: "feature/beta" }
  ]
}

const groups = (page: Page) => page.getByTestId("editor-group")

test("chats, files and views are tabs that split both ways and stay per session", async ({ launchApp }) => {
  const { window } = await launchApp({
    configured: true,
    isolateSystemHome: true,
    withRepo: true,
    sessions,
    seed: ({ repoPath }) => writeFileSync(join(repoPath, "a.ts"), "export const a = 1\n")
  })
  await expect(appShell(window)).toBeVisible()
  await window.locator("[data-testid^='session-row-']").filter({ hasText: "Alpha session" }).first().click()

  // Tabs live inside the group, not the window title bar.
  await expect(window.getByTestId("editor-tab-chat-c_main")).toBeVisible()
  await expect(window.getByTestId("title-bar").getByRole("tab")).toHaveCount(0)

  // The sidebar tree lists the session's chats; clicking one opens it as a tab.
  const tree = window.getByTestId("session-tree-s_alpha")
  await tree.getByText("Side chat").click()
  await expect(window.getByTestId("editor-tab-chat-c_side")).toBeVisible()

  // Quick-open creates a normal file tab in the focused group.
  await window.keyboard.press("Meta+Shift+p")
  await window.getByPlaceholder("Open a file in Alpha session…").fill("a.ts")
  await window.getByTestId("palette-item-file:a.ts").click()
  await expect(window.getByTestId("editor-tab-file-a.ts")).toBeVisible()

  // Open a view from the + menu, then split it down.
  await window.getByRole("button", { name: "New tab" }).click()
  await window.getByTestId("new-tab-option-terminal").click()
  await expect(window.getByTestId("editor-tab-view-terminal")).toBeVisible()
  await window.getByRole("button", { name: "Split down" }).click()
  await expect(window.getByTestId("editor-split-column")).toBeVisible()
  await expect(groups(window)).toHaveCount(2)

  // Drag a chat from the sidebar onto the right edge of the first group.
  await dragTo(window, '[data-testid="session-tree-chat-c_side"] button', '[data-testid="editor-group"]', 0.95)
  await expect(window.getByTestId("editor-split-row")).toBeVisible()
  await expect(groups(window)).toHaveCount(3)

  // The open terminal appears under "Session views"; closing it from the
  // sidebar closes every copy and drops the row.
  await expect(tree.getByTestId("session-tree-view-terminal")).toBeVisible()
  await tree.getByTestId("session-tree-view-terminal").hover()
  await tree.getByRole("button", { name: "Close Terminal everywhere" }).click()
  await expect(window.getByTestId("editor-tab-view-terminal")).toHaveCount(0)
  await expect(tree.getByTestId("session-tree-view-terminal")).toHaveCount(0)
  const kept = await groups(window).count()

  // Another session has its own layout; switching back restores this one.
  await window.locator("[data-testid^='session-row-']").filter({ hasText: "Beta session" }).first().click()
  await expect(window.getByTestId("editor-tab-chat-c_side")).toHaveCount(0)
  await window.locator("[data-testid^='session-row-']").filter({ hasText: "Alpha session" }).first().click()
  await expect(window.getByTestId("editor-tab-chat-c_side").first()).toBeVisible()
  await expect(groups(window)).toHaveCount(kept)
})

test("⌘T opens the focused group's tab-type chooser", async ({ launchApp }) => {
  const { window } = await launchApp({ configured: true, isolateSystemHome: true, withRepo: true, sessions })
  await expect(appShell(window)).toBeVisible()
  await window.locator("[data-testid^='session-row-']").filter({ hasText: "Alpha session" }).first().click()

  await window.keyboard.press("Meta+t")
  await expect(window.getByTestId("new-tab-command-menu")).toBeVisible()
  await window.getByTestId("palette-item-new-tab:terminal").click()
  await expect(window.getByTestId("editor-tab-view-terminal")).toBeVisible()
})

test("⌘\\ splits the focused tab right and ⌘⇧\\ splits it down", async ({ launchApp }) => {
  const { window } = await launchApp({ configured: true, isolateSystemHome: true, withRepo: true, sessions })
  await expect(appShell(window)).toBeVisible()
  await window.locator("[data-testid^='session-row-']").filter({ hasText: "Alpha session" }).first().click()
  await expect(groups(window)).toHaveCount(1)

  await window.keyboard.press("Meta+Backslash")
  await expect(window.getByTestId("editor-split-row")).toBeVisible()
  await window.keyboard.press("Meta+Shift+Backslash")
  await expect(window.getByTestId("editor-split-column")).toBeVisible()
  await expect(groups(window)).toHaveCount(3)
})
