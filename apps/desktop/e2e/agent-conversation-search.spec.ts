import { resolve } from "node:path"
import type { Chat, Message } from "@jingler/core"
import { appShell, expect, openModelSettings, test, type SeedSession } from "./fixtures.js"

const DATE = "2026-11-05T00:00:00.000Z"
const MODEL_BUTTON = /^Model:/
const CLAUDE_MODEL = /^Opus \(latest\)/
const PI_MODEL = /^Deterministic pi model 1/
const binary = resolve(import.meta.dirname, "../../../packages/cli-adapters/src/runtime/agent/fixtures/claude-conversation-search.mjs")
const chat = (id: string): Chat => ({ id, title: id, createdAt: DATE, updatedAt: DATE, mode: "auto" })
const message = (id: string, text: string): Message => ({ id, role: "assistant", parts: [{ _tag: "Text", text }], streaming: false, createdAt: DATE })
const session = (id: string, repoPath: string): SeedSession => ({
  id, title: id, repo: "widget", repoPath, worktreePath: repoPath, branch: "main", status: "idle",
  diff: { added: 0, removed: 0 }, prNumber: null, costUsd: 0, tokens: 0, updatedAt: DATE,
  chats: [chat(`${id}-chat`)], activeChatId: `${id}-chat`, workspaceMode: "direct"
})

for (const runtime of ["pi", "claude"] as const) {
  test(`${runtime} searches project history and reads neighboring text through real tools`, async ({ launchApp }, testInfo) => {
    const history = Array.from({ length: 450 }, (_, index) => message(`old-${index}`, index === 12 ? "The quartz capybara failure was investigated here." : index === 13 ? "Reset the shared pool before reconnecting." : `Ordinary old turn ${index}`))
    const { window } = await launchApp({
      configured: true, withRepo: true,
      piFixture: { scenarioId: "conversation-search", authRoute: "openai-codex-oauth" },
      e2eEnv: runtime === "claude" ? { JINGLER_CLAUDE_BINARY: binary } : undefined,
      sessions: ({ repoPath }) => [
        session("current", repoPath),
        { ...session("archive", repoPath), archived: true, closedChats: [chat("closed-chat")] },
        session("unrelated", `${repoPath}/unrelated`)
      ],
      transcripts: { "closed-chat": history, "unrelated-chat": [message("other", "quartz capybara from another project")] }
    })
    await expect(appShell(window)).toBeVisible()
    await openModelSettings(window)
    await window.getByRole("button", { name: MODEL_BUTTON }).click()
    await window.getByRole("option", { name: runtime === "claude" ? CLAUDE_MODEL : PI_MODEL }).click()
    const composer = window.getByPlaceholder("Message the agent…")
    await composer.fill("Search saved history for quartz capybara and read the surrounding context.")
    await composer.press("Enter")
    const answer = window.getByText("From saved chat closed-chat: Reset the shared pool before reconnecting.", { exact: true })
    await expect(answer).toBeVisible({ timeout: 20_000 })
    const recall = window.getByTestId("conversation-recall")
    await expect(recall).toHaveCount(1)
    await expect(recall.locator("summary")).toHaveText("Checked earlier chats")
    await expect(recall).not.toHaveAttribute("open")
    await expect(window.getByRole("button", { name: "Search chats", exact: true })).toBeHidden()
    await recall.locator("summary").click()
    await expect(window.getByRole("button", { name: "Search chats", exact: true })).toBeVisible()
    await expect(window.getByRole("button", { name: "Read chat", exact: true })).toBeVisible()
    await recall.locator("summary").click()
    await window.screenshot({ path: testInfo.outputPath(`${runtime}-history-tools.png`) })
    // A retained runtime must keep the same scoped tools on the following turn.
    await composer.fill("Find that saved conversation again.")
    await composer.press("Enter")
    await expect(answer).toHaveCount(2, { timeout: 20_000 })
  })
}
