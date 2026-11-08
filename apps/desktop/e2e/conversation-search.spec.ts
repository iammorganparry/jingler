import { readFileSync } from "node:fs"
import { join } from "node:path"
import type { Chat, Message } from "@jingler/core"
import type { Locator } from "@playwright/test"
import { appShell, expect, test, type SeedSession } from "./fixtures.js"

const PLACEHOLDER = "Jump to a session or run a command…"
const NEEDLE = "quartzcapybara retry regression"
const OUTLINE_RING = /ring-/
const DATE = "2026-11-05T00:00:00.000Z"
const chat = (id: string, title: string): Chat => ({ id, title, createdAt: DATE, updatedAt: DATE, mode: "auto" })
const message = (id: string, text: string, role: "user" | "assistant" = "assistant"): Message => ({ id, role, parts: [{ _tag: "Text", text }], streaming: false, createdAt: DATE })
const session = (id: string, title: string, chats: ReadonlyArray<Chat>): SeedSession => ({
  id, title, repo: "widget", branch: "main", status: "idle", diff: { added: 0, removed: 0 },
  prNumber: null, costUsd: 0, tokens: 0, updatedAt: DATE, chats, activeChatId: chats[0]!.id, workspaceMode: "direct"
})
const history = (chatId: string) => Array.from({ length: 450 }, (_, index) => message(
  `${chatId}-${index === 11 ? 12 : index}`,
  index === 12 ? `The ${NEEDLE} is caused by a stale socket after reconnect. Clear the pool before retrying, then open a fresh connection. Add a regression test that restarts the server between two requests.` : `Ordinary saved turn ${index}`,
  index === 12 || index % 2 ? "assistant" : "user"
))
const inCheckout = <T extends SeedSession>(entry: T, repoPath: string) => ({ ...entry, repoPath, worktreePath: repoPath })

/** Late row measurements must not move a search hit back to the end of the page. */
const expectStableMatch = async (match: Locator) => {
  let stable = 0
  await expect.poll(async () => {
    const visible = await match.evaluateAll((elements) => {
      const element = elements[0]
      const viewport = element?.closest('[data-testid="conversation-scroll"]')
      if (!element || !viewport) return false
      const row = element.getBoundingClientRect()
      const bounds = viewport.getBoundingClientRect()
      return row.bottom > bounds.top && row.top < bounds.bottom
    })
    stable = visible ? stable + 1 : 0
    return stable
  }, { intervals: [100] }).toBeGreaterThanOrEqual(6)
}

test("finds an old message in an archived workspace's closed chat and opens its exact page", async ({ launchApp }, testInfo) => {
  const active = session("current", "Current work", [chat("current-chat", "Current chat")])
  const archived = { ...session("old", "Storage cleanup", [chat("old-chat", "Recent chat")]), archived: true, closedChats: [chat("closed-chat", "Retry investigation")] }
  const { window, home } = await launchApp({
    configured: true, withRepo: true, sessions: ({ repoPath }) => [inCheckout(active, repoPath), inCheckout(archived, repoPath)],
    transcripts: { "closed-chat": history("closed-chat") }
  })
  await expect(appShell(window)).toBeVisible()
  await window.keyboard.press("Meta+k")
  await window.getByPlaceholder(PLACEHOLDER).fill(NEEDLE)
  const hit = window.getByTestId("conversation-search-hit")
  await expect(hit).toHaveCount(1)
  await expect(hit).toContainText("Storage cleanup · Retry investigation")
  await window.screenshot({ path: testInfo.outputPath("search-results.png") })
  await window.getByPlaceholder(PLACEHOLDER).press("Enter")
  await expect(window.getByText("Viewing saved conversation text", { exact: true })).toBeVisible()
  const target = window.locator('[data-search-match="true"]')
  await expect(target).toContainText(NEEDLE)
  await expect(target).toBeInViewport()
  await expectStableMatch(target)
  await expect.poll(() => window.evaluate(() => [...(CSS.highlights.get("jingler-conversation-search") ?? [])].map((range) => range.toString()))).toEqual([NEEDLE])
  await expect(window.getByTestId("load-earlier")).toHaveCount(0)
  const stored = JSON.parse(readFileSync(join(home, "jingler/sessions.json"), "utf8"))
  expect(stored.find((entry: { id: string }) => entry.id === "old").archived).toBe(true)
  await window.screenshot({ path: testInfo.outputPath("search-result-open.png") })
  await window.getByRole("button", { name: "Back to latest", exact: true }).click()
  await expect.poll(() => window.evaluate(() => CSS.highlights.has("jingler-conversation-search"))).toBe(false)
  await expect(window.getByText("Viewing saved conversation text", { exact: true })).toHaveCount(0)
  await expect(window.getByText("Ordinary saved turn 449", { exact: true })).toBeInViewport()
})

test("Chat scope searches only the current chat and closing clears the query", async ({ launchApp }) => {
  const current = session("current", "Current work", [chat("first", "First chat"), chat("second", "Second chat")])
  const other = session("other", "Other work", [chat("third", "Third chat")])
  const { window } = await launchApp({
    configured: true, withRepo: true, sessions: ({ repoPath }) => [inCheckout(current, repoPath), inCheckout(other, repoPath)],
    transcripts: Object.fromEntries(["first", "second", "third"].map((id) => [id, [message(id, `The ${NEEDLE} in ${id}`)]]))
  })
  await expect(appShell(window)).toBeVisible()
  await window.keyboard.press("Meta+k")
  await window.getByPlaceholder(PLACEHOLDER).fill(NEEDLE)
  await expect(window.getByTestId("conversation-search-hit")).toHaveCount(3)
  // Select a different chat first: narrowing scope must replace that selection.
  await window.getByPlaceholder(PLACEHOLDER).press("ArrowDown")
  await window.getByPlaceholder(PLACEHOLDER).press("Tab")
  await expect(window.getByTestId("conversation-search-hit")).toHaveCount(1)
  await expect(window.getByTestId("conversation-search-hit")).toContainText("Current work · First chat")
  await expect(window.getByTestId("conversation-search-hit")).toHaveAttribute("data-selected", "true")
  await window.getByPlaceholder(PLACEHOLDER).press("Enter")
  await expect(window.locator('[data-search-match="true"]')).toContainText(NEEDLE)
  await window.getByRole("button", { name: "Back to latest", exact: true }).click()
  await window.keyboard.press("Meta+k")
  await window.getByPlaceholder(PLACEHOLDER).fill(NEEDLE)
  await window.keyboard.press("Escape")
  await window.keyboard.press("Meta+k")
  await expect(window.getByPlaceholder(PLACEHOLDER)).toHaveValue("")
  await expect(window.getByTestId("conversation-search-hit")).toHaveCount(0)
})

test("limits results and treats punctuation as literal text", async ({ launchApp }) => {
  const { window } = await launchApp({
    configured: true, withRepo: true, sessions: ({ repoPath }) => [inCheckout(session("literal", "Literal search", [chat("literal-chat", "Cache work")]), repoPath)],
    transcripts: { "literal-chat": Array.from({ length: 25 }, (_, index) => message(`literal-${index}`, `Fix cache[retry] result ${index}`)) }
  })
  await expect(appShell(window)).toBeVisible()
  await window.keyboard.press("Meta+k")
  await window.getByPlaceholder(PLACEHOLDER).fill("cache[retry]")
  await expect(window.getByTestId("conversation-search-hit")).toHaveCount(20)
  await expect(window.getByText("Showing 20 matches. Refine your search for more.", { exact: true })).toBeVisible()
})

test("highlights the phrase while preserving Markdown and the normal message layout", async ({ launchApp }) => {
  const text = "Reset `cache[retry]` before reconnecting. Keep **the retry budget** unchanged."
  const { window } = await launchApp({
    configured: true, withRepo: true,
    sessions: ({ repoPath }) => [inCheckout(session("formatted", "Connection recovery", [chat("formatted-chat", "Retry investigation")]), repoPath)],
    transcripts: { "formatted-chat": [message("formatted-answer", text)] }
  })
  await expect(appShell(window)).toBeVisible()
  await window.keyboard.press("Meta+k")
  await window.getByPlaceholder(PLACEHOLDER).fill("cache[retry]")
  const hit = window.getByTestId("conversation-search-hit")
  await expect(hit.locator("mark")).toHaveText("cache[retry]")
  await window.getByPlaceholder(PLACEHOLDER).press("Enter")
  const target = window.locator('[data-search-match="true"]')
  await expect(target.locator("code")).toHaveText("cache[retry]")
  await expect(target.locator('[data-streamdown = "strong"]')).toHaveText("the retry budget")
  await expect(target).not.toHaveClass(OUTLINE_RING)
  await expect.poll(() => window.evaluate(() => [...(CSS.highlights.get("jingler-conversation-search") ?? [])].map((range) => range.toString()))).toEqual(["cache[retry]"])
})

test("returning from a search result keeps the draft and allows the live chat to continue", async ({ launchApp }) => {
  const { window } = await launchApp({
    configured: true, withRepo: true, sessions: ({ repoPath }) => [inCheckout(session("draft", "Draft preservation", [chat("draft-chat", "Draft chat")]), repoPath)],
    transcripts: { "draft-chat": history("draft-chat") }
  })
  await expect(appShell(window)).toBeVisible()
  const composer = window.locator("textarea").filter({ visible: true }).first()
  await composer.fill("Keep this draft")
  await window.keyboard.press("Meta+k")
  await window.getByPlaceholder(PLACEHOLDER).fill(NEEDLE)
  await expect(window.getByTestId("conversation-search-hit")).toHaveCount(1)
  await window.getByPlaceholder(PLACEHOLDER).press("Enter")
  await expect(window.locator('[data-search-match="true"]')).toContainText(NEEDLE)
  await expect(window.locator('[data-search-match="true"]')).toBeInViewport()
  await expectStableMatch(window.locator('[data-search-match="true"]'))
  await expect(composer).toBeDisabled()
  await window.getByRole("button", { name: "Back to latest", exact: true }).click()
  await expect(composer).toBeEnabled()
  await expect(composer).toHaveValue("Keep this draft")
  await composer.press("Enter")
  await expect(window.getByText("Completed through deterministic pi.", { exact: false })).toBeVisible({ timeout: 25000 })
})
