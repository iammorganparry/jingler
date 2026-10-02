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

const dragTo = async (
  page: Page,
  sourceSelector: string,
  targetSelector: string,
  x: number,
  y = 0.5,
  groupIndexes?: { source: number; target: number }
) => {
  await page.evaluate(
    ({ sourceSelector, targetSelector, x, y, groupIndexes }) => {
      const groups = document.querySelectorAll('[data-testid="editor-group"]')
      const sourceRoot = groupIndexes ? groups[groupIndexes.source] : document
      const targetRoot = groupIndexes ? groups[groupIndexes.target] : document
      const source = sourceRoot?.querySelector(sourceSelector)
      const target = targetRoot?.querySelector(targetSelector)
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
    { sourceSelector, targetSelector, x, y, groupIndexes }
  )
}

const rejectedFileDrag = async (page: Page, sourceSelector: string, targetGroup: number) =>
  page.evaluate(async ({ sourceSelector, targetGroup }) => {
    const source = document.querySelector(sourceSelector)
    const target = document.querySelectorAll('[data-testid="editor-group"]')[targetGroup]
    if (!(source && target)) throw new Error(`missing rejected drag node: ${sourceSelector}`)
    const dataTransfer = new DataTransfer()
    const box = target.getBoundingClientRect()
    const init = {
      dataTransfer,
      bubbles: true,
      cancelable: true,
      clientX: box.left + box.width / 2,
      clientY: box.top + box.height / 2
    }
    source.dispatchEvent(new DragEvent("dragstart", init))
    target.dispatchEvent(new DragEvent("dragover", init))
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
    const overlay = target.querySelector('[data-testid="editor-drop-overlay"]')
    const result = {
      rejected: overlay?.getAttribute("data-rejected"),
      className: overlay?.getAttribute("class"),
      dropEffect: dataTransfer.dropEffect
    }
    target.dispatchEvent(new DragEvent("drop", init))
    source.dispatchEvent(new DragEvent("dragend", init))
    return result
  }, { sourceSelector, targetGroup })

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

test("chats stay left while files and views share a persistent right pane", async ({ launchApp }) => {
  const { window } = await launchApp({
    configured: true,
    isolateSystemHome: true,
    withRepo: true,
    sessions,
    seed: ({ repoPath }) => writeFileSync(join(repoPath, "a.ts"), "export const a = 1\n")
  })
  await expect(appShell(window)).toBeVisible()
  await window.locator("[data-testid^='session-row-']").filter({ hasText: "Alpha session" }).first().click()

  await expect(groups(window)).toHaveCount(1)
  await expect(window.getByTestId("editor-tab-chat-c_main")).toBeVisible()
  const tree = window.getByTestId("session-tree-s_alpha")
  await tree.getByText("Side chat").click()
  await expect(groups(window)).toHaveCount(1)
  await expect(window.getByTestId("editor-tab-chat-c_side")).toBeVisible()

  await window.keyboard.press("Meta+Shift+p")
  await window.getByPlaceholder("Open a file in Alpha session…").fill("a.ts")
  await window.getByTestId("palette-item-file:a.ts").click()
  await expect(groups(window)).toHaveCount(2)
  await expect(groups(window).nth(0).getByTestId("editor-tab-chat-c_side")).toBeVisible()
  await expect(groups(window).nth(1).getByTestId("editor-tab-file-a.ts")).toBeVisible()
  await expect(window.locator('[data-split-child="0"]')).toHaveCSS("flex-grow", "0.333333")
  await expect(window.locator('[data-split-child="1"]')).toHaveCSS("flex-grow", "0.666667")

  const rejected = await rejectedFileDrag(window, '[data-testid="session-tree-file-a.ts"] button', 0)
  expect(rejected).toEqual(expect.objectContaining({ rejected: "true", dropEffect: "none" }))
  expect(rejected.className).toContain("ring-red")
  await expect(groups(window).nth(0).getByTestId("editor-tab-file-a.ts")).toHaveCount(0)
  await expect(groups(window).nth(1).getByTestId("editor-tab-file-a.ts")).toBeVisible()

  await groups(window).nth(1).getByRole("button", { name: "New tab" }).click()
  await window.getByTestId("new-tab-option-terminal").click()
  await expect(groups(window)).toHaveCount(2)
  await expect(groups(window).nth(1).getByTestId("editor-tab-view-terminal")).toBeVisible()

  // Dropping a chat on the content pane still routes it to the chat pane.
  await dragTo(window, '[data-testid="session-tree-chat-c_side"] button', '[aria-label="Editor group: Terminal"]', 0.5)
  await expect(groups(window)).toHaveCount(2)
  await expect(groups(window).nth(0).getByTestId("editor-tab-chat-c_side")).toBeVisible()
  await expect(groups(window).nth(1).getByTestId("editor-tab-chat-c_side")).toHaveCount(0)

  await tree.getByTestId("session-tree-view-terminal").hover()
  await tree.getByRole("button", { name: "Close Terminal everywhere" }).click()
  await expect(window.getByTestId("editor-tab-view-terminal")).toHaveCount(0)
  await expect(groups(window)).toHaveCount(2)

  await window.locator("[data-testid^='session-row-']").filter({ hasText: "Beta session" }).first().click()
  await expect(window.getByTestId("editor-tab-chat-c_side")).toHaveCount(0)
  await window.locator("[data-testid^='session-row-']").filter({ hasText: "Alpha session" }).first().click()
  await expect(groups(window)).toHaveCount(2)
  await expect(window.getByTestId("editor-tab-chat-c_side")).toBeVisible()
})

test("closing an untouched chat tab removes it from the sidebar", async ({ launchApp }) => {
  const { window } = await launchApp({
    configured: true,
    isolateSystemHome: true,
    withRepo: true,
    sessions,
    transcripts: {
      s_beta: [{
        id: "u_beta_1",
        role: "user",
        parts: [{ _tag: "Text", text: "Keep this chat." }],
        streaming: false,
        createdAt: "2026-10-01T00:00:00.000Z"
      }]
    }
  })
  await expect(appShell(window)).toBeVisible()
  await window.locator("[data-testid^='session-row-']").filter({ hasText: "Beta session" }).first().click()
  await expect(window.getByText("Keep this chat.")).toBeVisible()

  await window.getByRole("button", { name: "New tab" }).click()
  await window.getByTestId("new-tab-option-chat").click()
  await expect(window.getByRole("tab", { name: "Chat 2" })).toBeVisible()
  await expect(window.getByTestId("session-tree-s_beta").getByText("Chat 2")).toBeVisible()

  await window.getByRole("tab", { name: "Chat 2" }).locator("..").getByRole("button", { name: "Close Chat 2" }).click()

  await expect(window.getByRole("tab", { name: "Chat 2" })).toHaveCount(0)
  await expect(window.getByTestId("session-tree-s_beta").getByText("Chat 2")).toHaveCount(0)
  await expect(window.getByTestId("session-tree-s_beta").getByText(/^Closed/)).toHaveCount(0)

  // Closing a chat with history only closes its tab; its sidebar entry remains.
  await window.getByRole("tab", { name: "Chat 1" }).locator("..").getByRole("button", { name: "Close Chat 1" }).click()
  await expect(window.getByRole("tab", { name: "Chat 1" })).toHaveCount(0)
  await expect(window.getByTestId("session-tree-s_beta").getByText("Chat 1")).toBeVisible()
})

test("dragging file and view tabs creates horizontal and vertical splits", async ({ launchApp }) => {
  const { window } = await launchApp({
    configured: true,
    isolateSystemHome: true,
    withRepo: true,
    sessions,
    seed: ({ repoPath }) => {
      writeFileSync(join(repoPath, "a.ts"), "export const a = 1\n")
      writeFileSync(join(repoPath, "b.ts"), "export const b = 2\n")
    }
  })
  await expect(appShell(window)).toBeVisible()
  await window.locator("[data-testid^='session-row-']").filter({ hasText: "Alpha session" }).first().click()

  const openFile = async (path: string) => {
    await window.keyboard.press("Meta+Shift+p")
    await window.getByPlaceholder("Open a file in Alpha session…").fill(path)
    await window.getByTestId(`palette-item-file:${path}`).click()
  }
  await openFile("a.ts")
  await openFile("b.ts")
  await expect(groups(window)).toHaveCount(2)

  await dragTo(window, '[data-testid="editor-tab-file-b.ts"]', '[aria-label="Editor group: b.ts"]', 0.95)
  await expect(groups(window)).toHaveCount(3)
  await expect(window.getByTestId("editor-split-row")).toBeVisible()

  await groups(window).nth(1).getByRole("tab", { name: "a.ts" }).click()
  await groups(window).nth(1).getByRole("button", { name: "New tab" }).click()
  await window.getByTestId("new-tab-option-terminal").click()
  await dragTo(window, '[data-testid="editor-tab-view-terminal"]', '[aria-label="Editor group: Terminal"]', 0.5, 0.95)

  await expect(groups(window)).toHaveCount(4)
  await expect(window.getByTestId("editor-split-column")).toBeVisible()
  await expect(window.getByTestId("editor-tab-file-b.ts")).toBeVisible()
  await expect(window.getByTestId("editor-tab-view-terminal")).toBeVisible()
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

test("⌘W closes the focused editor tab without closing the app window", async ({ launchApp }) => {
  const { window } = await launchApp({
    configured: true,
    isolateSystemHome: true,
    withRepo: true,
    sessions,
    seed: ({ repoPath }) => writeFileSync(join(repoPath, "close-me.ts"), "export const open = true\n")
  })
  await expect(appShell(window)).toBeVisible()
  await window.locator("[data-testid^='session-row-']").filter({ hasText: "Alpha session" }).first().click()
  await window.keyboard.press("Meta+Shift+p")
  await window.getByPlaceholder("Open a file in Alpha session…").fill("close-me.ts")
  await window.getByTestId("palette-item-file:close-me.ts").click()
  await expect(window.getByTestId("editor-tab-file-close-me.ts")).toBeVisible()

  await window.keyboard.press("Meta+w")

  await expect(window.getByTestId("editor-tab-file-close-me.ts")).toHaveCount(0)
  await expect(appShell(window)).toBeVisible()
})

test("legacy split shortcuts cannot create duplicate panes", async ({ launchApp }) => {
  const { window } = await launchApp({ configured: true, isolateSystemHome: true, withRepo: true, sessions })
  await expect(appShell(window)).toBeVisible()
  await window.locator("[data-testid^='session-row-']").filter({ hasText: "Alpha session" }).first().click()
  await expect(groups(window)).toHaveCount(1)

  await window.keyboard.press("Meta+Backslash")
  await window.keyboard.press("Meta+Shift+Backslash")
  await expect(groups(window)).toHaveCount(1)
})
