import { resolve } from "node:path"
import { appShell, expect, test } from "./fixtures.js"

const fixtureDir = resolve(import.meta.dirname, "../../../packages/cli-adapters/src/runtime/agent/fixtures")
const binary = resolve(fixtureDir, "claude-subagent.mjs")
const worker = resolve(import.meta.dirname, "fake-subagent-process-worker.mjs")

test("native Claude delegates through bundled PI without a PI provider credential", async ({ launchApp }) => {
  const launched = await launchApp({
    configured: true,
    withRepo: true,
    piFixture: { scenarioId: "composer-capabilities", authRoute: "openai-codex-oauth" },
    e2eEnv: {
      JINGLER_CLAUDE_BINARY: binary,
      JINGLER_SUBAGENT_PROCESS_WORKER: worker
    },
    sessions: ({ repoPath }) => [{
      id: "s_native_claude_subagent", repo: "widget", repoPath, worktreePath: repoPath,
      branch: "main", title: "Claude PI child", status: "idle", diff: { added: 0, removed: 0 },
      prNumber: null, costUsd: 0, tokens: 0, updatedAt: "2026-09-25T00:00:00.000Z",
      workspaceMode: "direct"
    }]
  })
  const { window } = launched
  await expect(appShell(window)).toBeVisible()
  await window.getByRole("button", { name: /^Model:/ }).click()
  await expect(window.getByText("Claude Code", { exact: true })).toBeVisible()
  await window.getByRole("option", { name: /^Haiku \(latest\)/ }).click()
  const composer = window.getByPlaceholder("Message the agent…")
  await composer.fill("Delegate this native Claude task to the researcher.")
  await composer.press("Enter")
  await expect(window.getByText("Native Claude received the PI-backed child result.", { exact: true }))
    .toBeVisible({ timeout: 30_000 })
})
