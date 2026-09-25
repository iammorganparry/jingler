import { resolve } from "node:path"
import { appShell, expect, test } from "./fixtures.js"

const binary = resolve(import.meta.dirname, "../../../packages/cli-adapters/src/runtime/agent/fixtures/claude-tools.mjs")

test("native Claude consumes two real Jingler tool results before its final answer", async ({ launchApp }) => {
  const { window } = await launchApp({
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
  await expect(appShell(window)).toBeVisible()
  await window.getByRole("button", { name: /^Model:/ }).click()
  await expect(window.getByText("Claude Code", { exact: true })).toBeVisible()
  await window.getByRole("option", { name: /^Opus \(latest\)/ }).click()
  const composer = window.getByPlaceholder("Message the agent…")
  await composer.fill("Read README.md twice and report the results.")
  await composer.press("Enter")
  await expect(window.getByText("Claude completed two workspace tool rounds.", { exact: true })).toBeVisible({ timeout: 20_000 })
})
