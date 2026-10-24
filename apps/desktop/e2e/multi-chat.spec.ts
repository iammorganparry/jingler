import type { Page } from "@playwright/test"
import { expect, sessionRow, test } from "./fixtures.js"
import type { SeedSession } from "./fixtures.js"

const session: SeedSession = {
  id: "s_multi",
  repo: "widget",
  branch: "chore/multi-chat",
  title: "Multi-chat lifecycle",
  status: "idle",
  diff: { added: 0, removed: 0 },
  prNumber: null,
  costUsd: 0,
  tokens: 0,
  updatedAt: "2026-07-24T10:00:00.000Z"
}

const mainConversation = [
  {
    id: "u_multi_1",
    role: "user",
    parts: [{ _tag: "Text", text: "Keep the release checklist in this chat." }],
    streaming: false,
    createdAt: "2026-07-24T10:00:00.000Z"
  },
  {
    id: "a_multi_2",
    role: "assistant",
    parts: [{ _tag: "Text", text: "The release checklist is ready." }],
    streaming: false,
    createdAt: "2026-07-24T10:00:01.000Z"
  }
]

const activeChat = (window: Page) => window.getByTestId("thread-switcher")
const treeChat = (window: Page, name: string) =>
  // The row's accessible name leads with its status dot ("Idle Chat 1").
  window.getByTestId("session-tree-s_multi").getByRole("button", { name: new RegExp(`^(Idle|Running) ${name}$`) })
const renameInTree = async (window: Page, from: string, to: string) => {
  await treeChat(window, from).dblclick()
  const title = window.getByRole("textbox", { name: "Chat title" })
  await title.fill(to)
  await title.press("Enter")
}

test("chat selection and titles survive a real app restart", async ({ launchApp }) => {
  const first = await launchApp({
    configured: true,
    withRepo: true,
    sessions: (context) => [{ ...session, worktreePath: context.repoPath }]
  })

  await sessionRow(first.window, "Multi-chat lifecycle").click()
  await expect(activeChat(first.window)).toContainText("Chat 1")
  await first.window.getByRole("button", { name: "New tab" }).first().click()
  await first.window.getByTestId("new-chat-button").click()
  await expect(activeChat(first.window)).toContainText("Chat 2")
  await renameInTree(first.window, "Chat 2", "Review migrations")
  await expect(activeChat(first.window)).toContainText("Review migrations")
  await first.app.close()

  const second = await launchApp({
    home: first.home,
    reposDir: first.reposDir,
    configured: true,
    withRepo: true
  })

  await sessionRow(second.window, "Multi-chat lifecycle").click()
  await expect(activeChat(second.window)).toContainText("Review migrations")
  await expect(treeChat(second.window, "Chat 1")).toBeVisible()
})

test("a new chat stays empty while its own transcript loads", async ({ launchApp }) => {
  const launched = await launchApp({
    configured: true,
    withRepo: true,
    sessions: (context) => [{ ...session, worktreePath: context.repoPath }],
    transcripts: { s_multi: mainConversation }
  })

  await sessionRow(launched.window, "Multi-chat lifecycle").click()
  await expect(launched.window.getByText("The release checklist is ready.")).toBeVisible()
  await launched.window.getByRole("button", { name: "New tab" }).first().click()
  await launched.window.getByTestId("new-chat-button").click()
  await expect(activeChat(launched.window)).toContainText("Chat 2")

  const activeBody = launched.window.locator('[data-testid="editor-group"][data-focused="true"] [data-testid^="editor-body-"]:not([hidden])')
  await expect(activeBody).toBeVisible()
  await Promise.all([250, 500, 1_000, 2_000, 4_000].map(async (delay) => {
    await launched.window.waitForTimeout(delay)
    expect(await activeBody.getByText("The release checklist is ready.").count()).toBe(0)
  }))
})

test("a closed chat can be reopened with its transcript after a real app restart", async ({
  launchApp
}) => {
  const first = await launchApp({
    configured: true,
    withRepo: true,
    sessions: (context) => [{ ...session, worktreePath: context.repoPath }],
    transcripts: { s_multi: mainConversation }
  })

  await sessionRow(first.window, "Multi-chat lifecycle").click()
  await expect(first.window.getByText("The release checklist is ready.")).toBeVisible()
  await renameInTree(first.window, "Chat 1", "Main workspace")
  await first.window.getByRole("button", { name: "New tab" }).first().click()
  await first.window.getByTestId("new-chat-button").click()
  await treeChat(first.window, "Main workspace").click({ button: "right" })
  await first.window.getByRole("menuitem", { name: "Close chat" }).click()
  await expect(first.window.getByRole("button", { name: "Closed (1)" })).toBeVisible()
  await expect(first.window.getByText("The release checklist is ready.")).toHaveCount(0)
  await first.app.close()

  const second = await launchApp({
    home: first.home,
    reposDir: first.reposDir,
    configured: true,
    withRepo: true
  })

  await sessionRow(second.window, "Multi-chat lifecycle").click()
  await second.window.getByRole("button", { name: "Closed (1)" }).click()
  await second.window.getByRole("button", { name: "Reopen Main workspace" }).click()
  await expect(activeChat(second.window)).toContainText("Main workspace")
  await expect(second.window.getByText("The release checklist is ready.")).toBeVisible()
})

test("switch chat thread via the lane header dropdown", async ({ launchApp }) => {
  const launched = await launchApp({
    configured: true,
    withRepo: true,
    sessions: (context) => [{ ...session, worktreePath: context.repoPath }],
    transcripts: { s_multi: mainConversation }
  })

  await sessionRow(launched.window, "Multi-chat lifecycle").click()
  
  // Create a second chat
  await launched.window.getByRole("button", { name: "New tab" }).first().click()
  await launched.window.getByTestId("new-chat-button").click()
  await renameInTree(launched.window, "Chat 2", "Review migrations")
  
  // The chat group's tab strip is not a tablist (the composer's Work mode segmented control is)
  const chatGroup = launched.window.locator('[data-testid="editor-group"][data-focused="true"]')
  await expect(chatGroup).toBeVisible()
  await expect(chatGroup.locator('[role="tablist"]:not([aria-label="Work mode"])')).toHaveCount(0)
  
  // Should have the chat lane header
  await expect(launched.window.getByTestId("chat-lane-header")).toBeVisible()
  
  // Switch back to Chat 1 via the dropdown
  await launched.window.getByTestId("thread-switcher").click()
  await launched.window.getByRole("menuitem", { name: "Chat 1", exact: true }).click()
  
  // Chat 1 should now be active
  await expect(launched.window.getByTestId("thread-switcher")).toContainText("Chat 1")
  await expect(launched.window.getByText("The release checklist is ready.")).toBeVisible()
  
  // Switch to Review migrations
  await launched.window.getByTestId("thread-switcher").click()
  await launched.window.getByRole("menuitem", { name: "Review migrations", exact: true }).click()
  
  await expect(launched.window.getByTestId("thread-switcher")).toContainText("Review migrations")
})

