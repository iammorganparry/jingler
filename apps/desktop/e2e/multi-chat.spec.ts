import { expect, sessionRow, test } from "./fixtures.js"
import type { SeedSession } from "./fixtures.js"

const session: SeedSession = {
  id: "s_multi",
  repo: "widget",
  branch: "chore/multi-chat",
  title: "Multi-chat lifecycle",
  status: "idle",
  cli: "claude",
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

test("chat selection and titles survive a real app restart", async ({ launchApp }) => {
  const first = await launchApp({
    configured: true,
    withRepo: true,
    sessions: (context) => [{ ...session, worktreePath: context.repoPath }]
  })

  await sessionRow(first.window, "Multi-chat lifecycle").click()
  await expect(first.window.getByTitle("1. Chat 1")).toBeVisible()
  await first.window.getByRole("button", { name: "New chat" }).click()
  const secondChat = first.window.getByTitle("2. Chat 2")
  await expect(secondChat).toHaveAttribute("aria-current", "page")
  await secondChat.dblclick()
  const title = first.window.getByRole("textbox", { name: "Chat title" })
  await title.fill("Review migrations")
  await title.press("Enter")
  await expect(first.window.getByTitle("2. Review migrations")).toBeVisible()
  await first.app.close()

  const second = await launchApp({
    home: first.home,
    reposDir: first.reposDir,
    configured: true,
    withRepo: true
  })

  await sessionRow(second.window, "Multi-chat lifecycle").click()
  await expect(second.window.getByTitle("1. Chat 1")).toBeVisible()
  await expect(second.window.getByTitle("2. Review migrations")).toHaveAttribute(
    "aria-current",
    "page"
  )
  await second.window.getByRole("button", { name: "Close Review migrations" }).click()
  await expect(second.window.getByTitle("1. Chat 1")).toHaveAttribute("aria-current", "page")
  await second.window.getByRole("button", { name: "Close Chat 1" }).click()
  await expect(second.window.getByTitle("1. Chat 1")).toHaveAttribute("aria-current", "page")
  await second.app.close()

  const third = await launchApp({
    home: first.home,
    reposDir: first.reposDir,
    configured: true,
    withRepo: true
  })

  await sessionRow(third.window, "Multi-chat lifecycle").click()
  await expect(third.window.getByTitle("1. Chat 1")).toHaveAttribute("aria-current", "page")
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
  await first.window.getByTitle("1. Chat 1").dblclick()
  const title = first.window.getByRole("textbox", { name: "Chat title" })
  await title.fill("Main workspace")
  await title.press("Enter")
  await first.window.getByRole("button", { name: "New chat" }).click()
  await first.window.getByRole("button", { name: "Close Main workspace" }).click()
  await expect(first.window.getByRole("button", { name: "Closed chats" })).toBeVisible()
  await expect(first.window.getByText("The release checklist is ready.")).toHaveCount(0)
  await first.app.close()

  const second = await launchApp({
    home: first.home,
    reposDir: first.reposDir,
    configured: true,
    withRepo: true
  })

  await sessionRow(second.window, "Multi-chat lifecycle").click()
  await second.window.getByRole("button", { name: "Closed chats" }).click()
  await second.window.getByRole("menuitem", { name: "Reopen Main workspace" }).click()
  await expect(
    second.window.getByRole("button", { name: "Main workspace", exact: true })
  ).toHaveAttribute("aria-current", "page")
  await expect(second.window.getByText("The release checklist is ready.")).toBeVisible()
})
