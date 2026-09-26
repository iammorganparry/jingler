import { tmpdir } from "node:os"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { appShell, expect, test } from "./fixtures.js"

const binary = resolve(import.meta.dirname, "../../../packages/cli-adapters/src/runtime/codex/fixtures/app-server.mjs")

test("selects native Codex beside PI and preserves native continuation after reload", async ({ launchApp }) => {
  const launched = await launchApp({
    configured: true,
    withRepo: true,
    piFixture: { scenarioId: "composer-capabilities", authRoute: "openai-codex-oauth" },
    e2eEnv: { JINGLER_CODEX_BINARY: binary },
    sessions: ({ repoPath }) => [{
      id: "s_native_codex", repo: "widget", repoPath, worktreePath: repoPath,
      branch: "main", title: "Native Codex", status: "idle", diff: { added: 0, removed: 0 },
      prNumber: null, costUsd: 0, tokens: 0, updatedAt: "2026-09-25T00:00:00.000Z",
      workspaceMode: "direct"
    }]
  })
  const { window } = launched
  await expect(appShell(window)).toBeVisible()
  await window.getByRole("button", { name: /^Model:/ }).click()
  await expect(window.getByText("Codex CLI", { exact: true })).toBeVisible()
  await expect(window.getByText(/^PI ·/).first()).toBeVisible()
  await window.getByRole("option", { name: /^First/ }).click()
  const composer = window.getByPlaceholder("Message the agent…")
  await composer.fill("native first turn")
  await composer.press("Enter")
  await expect(window.getByText("Codex: native first turn", { exact: true })).toBeVisible({ timeout: 20_000 })
  const sessions = () => JSON.parse(readFileSync(join(launched.home, "jingler", "sessions.json"), "utf8"))
  const nativeChat = () => sessions().find((session: { id: string }) => session.id === "s_native_codex").chats[0]
  await expect.poll(() => nativeChat().continuation).toEqual({ runtimeId: "codex", endpointId: "desktop:codex:default", id: "thread-1" })
  const nativeContinuation = nativeChat().continuation
  await window.reload()
  await expect(appShell(window)).toBeVisible()
  await composer.fill("native resumed turn")
  await composer.press("Enter")
  await expect(window.getByText("Codex resumed: native resumed turn", { exact: true })).toBeVisible({ timeout: 20_000 })
  expect(nativeChat().continuation).toEqual(nativeContinuation)
  // A second chat keeps the PI route and its own continuation beside the native one.
  await window.getByRole("button", { name: "New tab" }).click()
  await window.getByTestId("new-tab-option-chat").click()
  await window.getByRole("button", { name: /^Model:/ }).click()
  await window.getByRole("option", { name: /^Deterministic pi model 1/ }).click()
  await composer.fill("pi coexistence turn")
  await composer.press("Enter")
  await expect(window.getByText("complete", { exact: true })).toBeVisible({ timeout: 20_000 })
  await expect.poll(() => sessions().find((session: { id: string }) => session.id === "s_native_codex").chats.some((chat: { continuation?: { runtimeId: string } }) => chat.continuation?.runtimeId === "pi")).toBe(true)
  expect(nativeChat().continuation).toEqual(nativeContinuation)
})


test("native Codex login can be canceled in settings", async ({ launchApp }) => {
  const { window } = await launchApp({ configured: true, withRepo: true, e2eEnv: { JINGLER_CODEX_BINARY: binary, CODEX_HOME: "signed-out" } })
  await expect(appShell(window)).toBeVisible()
  await window.getByRole("button", { name: "Account menu" }).click()
  await window.getByRole("menuitem", { name: "Settings" }).click()
  await window.getByRole("button", { name: /Providers/ }).click()
  await window.getByRole("button", { name: "Sign in to Codex CLI", exact: true }).click()
  await expect(window.getByText("Device code:")).toContainText("TEST")
  await window.getByRole("button", { name: "Cancel Codex sign-in" }).click()
  await expect(window.getByRole("button", { name: "Sign in to Codex CLI", exact: true })).toBeVisible()
})

test("native Codex device login unlocks onboarding through refreshed status", async ({ launchApp }) => {
  const codexHome = mkdtempSync(join(tmpdir(), "jingler-codex-login-"))
  try {
    const launched = await launchApp({ withRepo: true, piFixture: { scenarioId: "composer-capabilities", authRoute: "openai-codex-oauth", seedConnection: false }, e2eEnv: { JINGLER_CODEX_BINARY: binary, CODEX_HOME: codexHome } })
    const { window } = launched
    await launched.app.evaluate(({ dialog }, directory) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [directory] }) }, launched.reposDir)
    await window.getByRole("button", { name: "Choose repos folder" }).click()
    await window.getByRole("button", { name: "Continue", exact: true }).click()
    await window.getByRole("button", { name: "Skip for now" }).click()
    await window.getByRole("button", { name: "Sign in to Codex CLI", exact: true }).click()
    await expect(window.getByText("Device code:")).toContainText("TEST")
    // The fake provider completes outside Jingler, just like browser device authorization.
    writeFileSync(join(codexHome, "authenticated"), "yes")
    await window.getByRole("button", { name: "Check Codex sign-in" }).click()
    await expect(window.getByLabel("Native Codex login desktop")).toContainText("ready")
    await window.getByRole("button", { name: "Continue", exact: true }).click()
    await expect(window.getByRole("heading", { name: "Import agent resources" })).toBeVisible()
  } finally { rmSync(codexHome, { recursive: true, force: true }) }
})
