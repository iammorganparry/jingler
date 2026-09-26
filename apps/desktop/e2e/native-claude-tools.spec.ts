import { readFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { appShell, expect, test } from "./fixtures.js"

const binary = resolve(import.meta.dirname, "../../../packages/cli-adapters/src/runtime/agent/fixtures/claude-tools.mjs")

test("native Claude consumes two real Jingler tool results before its final answer", async ({ launchApp }) => {
  const launched = await launchApp({
    configured: true,
    withRepo: true,
    piFixture: { scenarioId: "composer-capabilities", authRoute: "openai-codex-oauth" },
    e2eEnv: { JINGLER_CLAUDE_BINARY: binary },
    sessions: ({ repoPath }) => [{
      id: "s_native_claude_tools", repo: "widget", repoPath, worktreePath: repoPath,
      branch: "main", title: "Claude tools", status: "idle", diff: { added: 0, removed: 0 },
      prNumber: null, costUsd: 0, tokens: 0, updatedAt: "2026-09-25T00:00:00.000Z",
      workspaceMode: "direct"
    }]
  })
  const { window } = launched
  await expect(appShell(window)).toBeVisible()
  const chat = () => JSON.parse(readFileSync(join(launched.home, "jingler", "sessions.json"), "utf8"))
    .find((session: { id: string }) => session.id === "s_native_claude_tools").chats[0]
  await window.getByRole("button", { name: /^Model:/ }).click()
  await window.getByRole("option", { name: /^Deterministic pi model 1/ }).click()
  await window.getByPlaceholder("Message the agent…").fill("PI first turn")
  await window.getByPlaceholder("Message the agent…").press("Enter")
  await expect.poll(() => chat().continuation?.runtimeId).toBe("pi")
  const chatId = chat().id
  await window.getByRole("button", { name: /^Model:/ }).click()
  await expect(window.getByText("Claude Code", { exact: true })).toBeVisible()
  await window.getByRole("option", { name: /^Opus \(latest\)/ }).click()
  await expect.poll(() => chat().continuation ?? null).toBeNull()
  expect(chat().id).toBe(chatId)
  const composer = window.getByPlaceholder("Message the agent…")
  await composer.fill("Read README.md twice and report the results.")
  await composer.press("Enter")
  await expect(window.getByText("Claude completed two workspace tool rounds.", { exact: true })).toBeVisible({ timeout: 20_000 })
  await expect.poll(() => chat().continuation?.runtimeId).toBe("claude")
  const continuation = chat().continuation
  await window.reload()
  await expect(appShell(window)).toBeVisible()
  await composer.fill("Read README.md again.")
  await composer.press("Enter")
  await expect(window.getByText("Claude completed two workspace tool rounds.", { exact: true })).toHaveCount(2, { timeout: 20_000 })
  expect(chat().continuation).toEqual(continuation)
  await window.getByRole("button", { name: /^Model:/ }).click()
  await window.getByRole("option", { name: /^Deterministic pi model 1/ }).click()
  await expect.poll(() => chat().continuation ?? null).toBeNull()
  expect(chat().id).toBe(chatId)
  await composer.fill("PI return turn")
  await composer.press("Enter")
  await expect.poll(() => chat().continuation?.runtimeId).toBe("pi")
})
