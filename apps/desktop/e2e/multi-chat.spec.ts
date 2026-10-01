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

const chatTab = (window: Page, name: string) => window.getByRole("tab", { name, exact: true })
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
  await expect(chatTab(first.window, "Chat 1")).toBeVisible()
  await first.window.getByRole("button", { name: "New tab" }).first().click()
  await first.window.getByTestId("new-tab-option-chat").click()
  await expect(chatTab(first.window, "Chat 2")).toHaveAttribute("aria-selected", "true")
  await renameInTree(first.window, "Chat 2", "Review migrations")
  await expect(chatTab(first.window, "Review migrations")).toBeVisible()
  await first.app.close()

  const second = await launchApp({
    home: first.home,
    reposDir: first.reposDir,
    configured: true,
    withRepo: true
  })

  await sessionRow(second.window, "Multi-chat lifecycle").click()
  await expect(chatTab(second.window, "Review migrations")).toHaveAttribute("aria-selected", "true")
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
  await launched.window.getByTestId("new-tab-option-chat").click()
  await expect(chatTab(launched.window, "Chat 2")).toHaveAttribute("aria-selected", "true")

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
  await first.window.getByTestId("new-tab-option-chat").click()
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
  await expect(chatTab(second.window, "Main workspace")).toHaveAttribute("aria-selected", "true")
  await expect(second.window.getByText("The release checklist is ready.")).toBeVisible()
})
