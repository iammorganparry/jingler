import { readFileSync } from "node:fs"
import { join } from "node:path"
import {
  appShell,
  expect,
  type SeedSession,
  test
} from "./fixtures.js"

const session = (id: string): ((input: { repoPath: string }) => ReadonlyArray<SeedSession>) =>
  ({ repoPath }) => [{
    id,
    repo: "widget",
    repoPath,
    branch: "main",
    title: "Capability workspace",
    status: "idle",
    cli: "claude",
    model: "opus",
    mode: "accept-edits",
    diff: { added: 0, removed: 0 },
    prNumber: null,
    costUsd: 0,
    tokens: 0,
    updatedAt: "2026-07-28T00:00:00.000Z",
    worktreePath: repoPath,
    workspaceMode: "direct"
  }]

const selectModel = async (
  window: Parameters<typeof appShell>[0],
  provider: "Claude Code" | "Codex CLI",
  model: string
) => {
  await window.getByRole("button", { name: /^Model:/ }).click()
  const modelButton = window.getByRole("button", { name: model, exact: true })
  if (await modelButton.count() === 0) {
    await window.getByRole("button").filter({ hasText: provider }).click()
  }
  await modelButton.click()
}

test("offers only Claude Code and Codex providers", async ({ launchApp }) => {
  const launched = await launchApp({
    configured: true,
    withRepo: true,
    sessions: session("s_supported_providers")
  })
  await expect(appShell(launched.window)).toBeVisible()
  await launched.window.getByRole("button", { name: /^Model:/ }).click()
  await expect(launched.window.getByText("Claude Code", { exact: true })).toBeVisible()
  await expect(launched.window.getByText("Codex CLI", { exact: true })).toBeVisible()
  await expect(launched.window.getByText(/OpenCode|Cursor Agent/i)).toHaveCount(0)
})

test("updates modes when switching from Claude to Codex", async ({ launchApp }) => {
  const launched = await launchApp({
    configured: true,
    withRepo: true,
    sessions: session("s_provider_modes")
  })
  await expect(appShell(launched.window)).toBeVisible()

  await launched.window.getByText("Accept edits", { exact: true }).click()
  await expect(launched.window.getByRole("menuitem", { name: "Default permissions" })).toBeVisible()
  await expect(launched.window.getByRole("menuitem", { name: "Read only" })).toHaveCount(0)
  await launched.window.keyboard.press("Escape")

  await selectModel(launched.window, "Codex CLI", "GPT-5.6 Sol")
  await launched.window.getByText("Workspace write", { exact: true }).click()
  await expect(launched.window.getByRole("menuitem", { name: "Read only" })).toBeVisible()
  await expect(launched.window.getByRole("menuitem", { name: "Default permissions" })).toHaveCount(0)
})

test("updates reasoning options when switching Codex models", async ({ launchApp }) => {
  const launched = await launchApp({
    configured: true,
    withRepo: true,
    sessions: session("s_reasoning_models")
  })
  await expect(appShell(launched.window)).toBeVisible()

  await selectModel(launched.window, "Codex CLI", "GPT-5.6 Luna")
  await launched.window.getByRole("button", { name: "Thinking strength" }).click()
  await expect(launched.window.getByRole("menuitem", { name: "medium", exact: true })).toBeVisible()
  await expect(launched.window.getByRole("menuitem", { name: "high", exact: true })).toHaveCount(0)
  await launched.window.keyboard.press("Escape")

  await selectModel(launched.window, "Codex CLI", "GPT-5.6 Sol")
  await launched.window.getByRole("button", { name: "Thinking strength" }).click()
  await expect(launched.window.getByRole("menuitem", { name: "high", exact: true })).toBeVisible()
  await expect(launched.window.getByRole("menuitem", { name: "xhigh", exact: true })).toBeVisible()
})

test("persists provider model mode and reasoning selections across restart", async ({ launchApp }) => {
  const first = await launchApp({
    configured: true,
    withRepo: true,
    sessions: session("s_capability_restart")
  })
  await expect(appShell(first.window)).toBeVisible()
  await selectModel(first.window, "Codex CLI", "GPT-5.6 Sol")
  await first.window.getByText("Workspace write", { exact: true }).click()
  await first.window.getByRole("menuitem", { name: "Full access" }).click()
  await first.window.getByRole("button", { name: "Thinking strength" }).click()
  await first.window.getByRole("menuitem", { name: "high", exact: true }).click()
  await expect.poll(() => {
    const persisted = JSON.parse(readFileSync(join(first.home, "jingler", "sessions.json"), "utf8"))[0]
    return {
      cli: persisted.cli,
      model: persisted.chats[0].model,
      mode: persisted.chats[0].mode,
      reasoning: persisted.reasoning
    }
  }).toEqual({
    cli: "codex",
    model: "gpt-5.6-sol",
    mode: "auto",
    reasoning: { codex: { enabled: true, effort: "high" } }
  })
  await first.app.close()

  const reopened = await launchApp({
    home: first.home,
    reposDir: first.reposDir,
    userDataDir: first.userDataDir,
    configured: true,
    withRepo: true
  })
  await expect(appShell(reopened.window)).toBeVisible()
  await expect(reopened.window.getByRole("button", { name: "Model: GPT-5.6 Sol" })).toBeVisible()
  await expect(reopened.window.getByText("Full access", { exact: true })).toBeVisible()
  await expect(reopened.window.getByRole("button", { name: "Thinking strength" })).toContainText("high")
})
