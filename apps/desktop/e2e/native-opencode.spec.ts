import { readFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { appShell, expect, test } from "./fixtures.js"

const binary = resolve(import.meta.dirname, "../../../packages/cli-adapters/src/runtime/opencode/fixtures/server.mjs")

test("selects OpenCode provider identity and resumes a persisted native session", async ({ launchApp }) => {
  const launched = await launchApp({
    configured: true, withRepo: true,
    piFixture: { scenarioId: "composer-capabilities", authRoute: "api-key" },
    e2eEnv: { JINGLER_OPENCODE_BINARY: binary },
    sessions: ({ repoPath }) => [{
      id: "s_native_opencode", repo: "widget", repoPath, worktreePath: repoPath,
      branch: "main", title: "Native OpenCode", status: "idle", diff: { added: 0, removed: 0 },
      prNumber: null, costUsd: 0, tokens: 0, updatedAt: "2026-09-25T00:00:00.000Z", workspaceMode: "direct"
    }]
  })
  const { window } = launched
  await expect(appShell(window)).toBeVisible()
  await window.getByRole("button", { name: /^Model:/ }).click()
  await expect(window.getByText("OpenCode CLI", { exact: true })).toBeVisible()
  await expect(window.getByRole("option", { name: /^OpenCode alpha/ })).toBeVisible()
  await window.getByRole("option", { name: /^OpenCode beta/ }).click()
  const composer = window.getByPlaceholder("Message the agent…")
  await composer.fill("native first turn")
  await composer.press("Enter")
  await expect(window.getByText("OpenCode: native first turn", { exact: true })).toBeVisible({ timeout: 20_000 })
  const chat = () => JSON.parse(readFileSync(join(launched.home, "jingler", "sessions.json"), "utf8")).find((session: { id: string }) => session.id === "s_native_opencode").chats[0]
  await expect.poll(() => chat().continuation?.runtimeId).toBe("opencode")
  expect(chat().providerId).toBe("beta")
  const continuation = chat().continuation
  await window.reload()
  await expect(appShell(window)).toBeVisible()
  await composer.fill("resumed turn")
  await composer.press("Enter")
  await expect(window.getByText("OpenCode: resumed turn", { exact: true })).toBeVisible({ timeout: 20_000 })
  expect(chat().continuation).toEqual(continuation)
})

test("detects connected OpenCode providers during onboarding", async ({ launchApp }) => {
  const launched = await launchApp({ withRepo: true, e2eEnv: { JINGLER_OPENCODE_BINARY: binary }, piFixture: { scenarioId: "composer-capabilities", authRoute: "api-key", seedConnection: false } })
  await launched.app.evaluate(({ dialog }, directory) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [directory] }) }, launched.reposDir)
  await launched.window.getByRole("button", { name: "Choose repos folder" }).click()
  await launched.window.getByRole("button", { name: "Continue", exact: true }).click()
  await launched.window.getByRole("button", { name: "Skip for now" }).click()
  await expect(launched.window.getByLabel("Detected agent runtimes")).toContainText("OpenCode CLI · ready")
  await launched.window.getByRole("button", { name: "Continue", exact: true }).click()
  await expect(launched.window.getByRole("heading", { name: "Import agent resources" })).toBeVisible()
})
