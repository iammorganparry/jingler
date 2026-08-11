import { existsSync, readFileSync } from "node:fs"
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
  await window.getByRole("option", { name: new RegExp(`^${provider}\\b`) }).click()
  await window.getByRole("option", { name: new RegExp(`^${model}\\b`) }).click()
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

  await launched.window.getByText("Accept Edits", { exact: true }).click()
  await expect(launched.window.getByRole("option", { name: /^Default\b/ })).toBeVisible()
  await expect(launched.window.getByRole("option", { name: /^Ask for approval\b/ })).toHaveCount(0)
  await launched.window.keyboard.press("Escape")

  await selectModel(launched.window, "Codex CLI", "GPT-5.6 Sol")
  await launched.window.getByText("Approve for me", { exact: true }).click()
  await expect(launched.window.getByRole("option", { name: /^Ask for approval\b/ })).toBeVisible()
  await expect(launched.window.getByRole("option", { name: /^Default\b/ })).toHaveCount(0)
})

test("updates reasoning options when switching Codex models", async ({ launchApp }) => {
  const launched = await launchApp({
    configured: true,
    withRepo: true,
    sessions: session("s_reasoning_models")
  })
  await expect(appShell(launched.window)).toBeVisible()

  await selectModel(launched.window, "Codex CLI", "GPT-5.5")
  await launched.window.getByRole("button", { name: "Thinking strength" }).click()
  await expect(launched.window.getByRole("option", { name: "Light", exact: true })).toBeVisible()
  await expect(launched.window.getByRole("option", { name: "Medium", exact: true })).toBeVisible()
  await expect(launched.window.getByRole("option", { name: "High", exact: true })).toBeVisible()
  await expect(launched.window.getByRole("option", { name: "Extra High", exact: true })).toBeVisible()
  await expect(launched.window.getByRole("option", { name: "Off", exact: true })).toHaveCount(0)
})

test("persists provider model mode and reasoning selections across restart", async ({ launchApp }) => {
  const first = await launchApp({
    configured: true,
    withRepo: true,
    sessions: session("s_capability_restart")
  })
  await expect(appShell(first.window)).toBeVisible()
  await selectModel(first.window, "Codex CLI", "GPT-5.6 Sol")
  await first.window.getByText("Approve for me", { exact: true }).click()
  await first.window.getByRole("option", { name: /^Full access\b/ }).click()
  await first.window.getByRole("button", { name: "Thinking strength" }).click()
  await first.window.getByRole("option", { name: "High", exact: true }).click()
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
  await expect(reopened.window.getByRole("button", { name: "Thinking strength" })).toContainText("High")
})

test("configures mode and reasoning before creating a session", async ({ launchApp }) => {
  const launched = await launchApp({ configured: true, withRepo: true })
  await expect(appShell(launched.window)).toBeVisible()
  await launched.window.getByTestId("new-session").click()

  const selectorWidths = await Promise.all(
    [
      launched.window.getByRole("button", { name: "Project", exact: true }),
      launched.window.getByRole("button", { name: "Checkout", exact: true }),
      launched.window.getByRole("button", { name: "Base branch", exact: true })
    ].map(async (selector) => (await selector.boundingBox())?.width)
  )
  const [projectWidth, ...otherWidths] = selectorWidths
  expect(projectWidth).toBeGreaterThanOrEqual(210)
  expect(otherWidths).toEqual([projectWidth, projectWidth])

  await selectModel(launched.window, "Codex CLI", "GPT-5.6 Sol")
  await launched.window.getByText("Full access", { exact: true }).click()
  await launched.window.getByRole("option", { name: /^Ask for approval\b/ }).click()
  await launched.window.getByRole("button", { name: "Thinking strength" }).click()
  await launched.window.getByRole("option", { name: "High", exact: true }).click()
  await launched.window.getByRole("button", { name: "Checkout" }).click()
  await launched.window.getByRole("option", { name: "Local" }).click()
  await launched.window.getByRole("button", { name: "Create workspace" }).click()

  await expect.poll(() => {
    const sessionsPath = join(launched.home, "jingler", "sessions.json")
    if (!existsSync(sessionsPath)) return null
    const persisted = JSON.parse(readFileSync(sessionsPath, "utf8"))[0]
    return {
      cli: persisted?.cli,
      model: persisted?.chats?.[0]?.model,
      mode: persisted?.chats?.[0]?.mode,
      reasoning: persisted?.reasoning
    }
  }).toEqual({
    cli: "codex",
    model: "gpt-5.6-sol",
    mode: "ask",
    reasoning: { codex: { enabled: true, effort: "high" } }
  })
})

test("blocks sending when the workspace harness is unavailable and offers recovery", async ({
  launchApp
}) => {
  const launched = await launchApp({
    configured: true,
    withRepo: true,
    sessions: session("s_unavailable_harness"),
    e2eEnv: { JINGLER_E2E_AVAILABLE_HARNESSES: "codex" }
  })
  await expect(appShell(launched.window)).toBeVisible()

  await expect(
    launched.window.getByRole("alert").filter({ hasText: "Claude Code is unavailable" })
  ).toBeVisible()
  await expect(launched.window.getByPlaceholder(/Claude Code is unavailable/)).toBeDisabled()
  await expect(launched.window.getByRole("button", { name: "Send ↵" })).toHaveCount(0)

  await selectModel(launched.window, "Codex CLI", "GPT-5.6 Sol")
  await expect(launched.window.getByPlaceholder(/Message Codex/i)).toBeEnabled()
})
