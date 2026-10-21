import { readFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { appShell, expect, test, openModelSettings } from "./fixtures.js"

const binary = resolve(import.meta.dirname, "fake-claude-models-cli.mjs")

test("the Claude model picker lists what the installed CLI reports, not a fixed list", async ({ launchApp }) => {
  const { window, home } = await launchApp({
    configured: true,
    withRepo: true,
    piFixture: { scenarioId: "composer-capabilities", authRoute: "openai-codex-oauth" },
    e2eEnv: { JINGLER_CLAUDE_BINARY: binary },
    sessions: ({ repoPath }) => [{
      id: "s_claude_models", repo: "widget", repoPath, worktreePath: repoPath,
      branch: "main", title: "Claude models", status: "idle", diff: { added: 0, removed: 0 },
      prNumber: null, costUsd: 0, tokens: 0, updatedAt: "2026-10-20T00:00:00.000Z",
      workspaceMode: "direct"
    }]
  })
  await expect(appShell(window)).toBeVisible()

  await openModelSettings(window)

  await window.getByRole("button", { name: /^Model:/ }).click()
  await expect(window.getByText("Claude Code", { exact: true })).toBeVisible()
  await expect(window.getByRole("option", { name: /^Sonnet 5\.5/ })).toBeVisible({ timeout: 20_000 })
  await expect(window.getByRole("option", { name: /^Fable 5\.1/ })).toBeVisible()
  await expect(window.getByRole("option", { name: /^Default/ })).toHaveCount(0)

  // Cached per CLI version so child pi processes see the same list.
  const cache = JSON.parse(readFileSync(join(home, "jingler", "cache", "claude-models.json"), "utf8"))
  expect(cache.version).toBe("2.1.286")
  expect(cache.models.find((m: { value: string }) => m.value === "sonnet")?.id).toBe("claude-sonnet-5-5")
})
