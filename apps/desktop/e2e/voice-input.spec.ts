import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { appShell, expect, test } from "./fixtures.js"

const whisper = resolve(import.meta.dirname, "fake-whisper-cli.mjs")

const session = (repoPath: string) => ({
  id: "s_voice", repo: "widget", repoPath, worktreePath: repoPath,
  branch: "main", title: "Voice", status: "idle", diff: { added: 0, removed: 0 },
  prNumber: null, costUsd: 0, tokens: 0, updatedAt: "2026-10-21T00:00:00.000Z",
  workspaceMode: "direct"
})

test("dictating puts the local transcript in the draft without sending it", async ({ launchApp }) => {
  const { window, home } = await launchApp({
    configured: true,
    withRepo: true,
    e2eEnv: { JINGLER_WHISPER_BIN: whisper },
    sessions: ({ repoPath }) => [session(repoPath)]
  })
  await expect(appShell(window)).toBeVisible()
  const models = join(home, "jingler", "models", "whisper")
  mkdirSync(models, { recursive: true })
  writeFileSync(join(models, "ggml-base.bin"), "fake")

  const composer = window.getByPlaceholder("Message the agent…")
  await composer.fill("Please")
  await window.getByRole("button", { name: "Voice input", exact: true }).click()
  await expect(window.getByRole("button", { name: "Stop recording", exact: true })).toBeVisible()
  await window.waitForTimeout(800)
  await window.getByRole("button", { name: "Stop recording", exact: true }).click()

  await expect(composer).toHaveValue("Please add a retry to the login test", { timeout: 20_000 })
  await expect(window.getByRole("button", { name: "Voice input", exact: true })).toBeEnabled()
  await expect(window.getByText("add a retry to the login test", { exact: true })).toHaveCount(0)
})

test("without a speech model the mic says so and Cancel discards a recording", async ({ launchApp }) => {
  const { window } = await launchApp({
    configured: true,
    withRepo: true,
    e2eEnv: { JINGLER_WHISPER_BIN: whisper },
    sessions: ({ repoPath }) => [session(repoPath)]
  })
  await expect(appShell(window)).toBeVisible()
  const composer = window.getByPlaceholder("Message the agent…")

  await window.getByRole("button", { name: "Voice input", exact: true }).click()
  await window.getByRole("button", { name: "Cancel recording", exact: true }).click()
  await expect(window.getByRole("button", { name: "Voice input", exact: true })).toBeVisible()

  await window.getByRole("button", { name: "Voice input", exact: true }).click()
  await window.waitForTimeout(500)
  await window.getByRole("button", { name: "Stop recording", exact: true }).click()
  await expect(window.getByRole("button", { name: /^No speech model installed/ })).toBeVisible({ timeout: 20_000 })
  await expect(composer).toHaveValue("")
})

const modelServer = async () => {
  const { createServer } = await import("node:http")
  const body = Buffer.from("fake whisper model bytes")
  const server = createServer((_, res) => res.end(body))
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done))
  const { port } = server.address() as import("node:net").AddressInfo
  const { createHash } = await import("node:crypto")
  return { server, url: `http://127.0.0.1:${port}`, sha: createHash("sha256").update(body).digest("hex") }
}

const openVoiceSettings = async (window: import("@playwright/test").Page) => {
  await window.getByRole("button", { name: /account|menu/i }).first().click().catch(() => {})
  await window.getByRole("menuitem", { name: "Settings" }).click()
  await window.getByRole("button", { name: "Voice", exact: true }).click()
}

test("Settings → Voice downloads a model with a matching checksum and shows it installed", async ({ launchApp }) => {
  const fake = await modelServer()
  try {
    const { window } = await launchApp({
      configured: true,
      withRepo: true,
      e2eEnv: { JINGLER_WHISPER_MODEL_BASE_URL: fake.url, JINGLER_E2E_WHISPER_SHA256: fake.sha },
      sessions: ({ repoPath }) => [session(repoPath)]
    })
    await expect(appShell(window)).toBeVisible()
    await openVoiceSettings(window)
    await window.getByRole("button", { name: "Download tiny.en", exact: true }).click()
    await expect(window.getByRole("button", { name: "Remove tiny.en", exact: true })).toBeVisible({ timeout: 20_000 })
  } finally {
    fake.server.close()
  }
})

test("Settings → Voice shows an error on a checksum mismatch", async ({ launchApp }) => {
  const fake = await modelServer()
  try {
    const { window } = await launchApp({
      configured: true,
      withRepo: true,
      e2eEnv: { JINGLER_WHISPER_MODEL_BASE_URL: fake.url, JINGLER_E2E_WHISPER_SHA256: "0".repeat(64) },
      sessions: ({ repoPath }) => [session(repoPath)]
    })
    await expect(appShell(window)).toBeVisible()
    await openVoiceSettings(window)
    await window.getByRole("button", { name: "Download tiny.en", exact: true }).click()
    await expect(window.getByText(/SHA-256/)).toBeVisible({ timeout: 20_000 })
    await expect(window.getByRole("button", { name: "Download tiny.en", exact: true })).toBeVisible()
  } finally {
    fake.server.close()
  }
})

test("the chosen language reaches the whisper CLI", async ({ launchApp }) => {
  const { window, home } = await launchApp({
    configured: true,
    withRepo: true,
    e2eEnv: { JINGLER_WHISPER_BIN: whisper, JINGLER_FAKE_WHISPER_ARGS_LOG: join(tmpdir(), "voice-args.log") },
    sessions: ({ repoPath }) => [session(repoPath)]
  })
  await expect(appShell(window)).toBeVisible()
  const models = join(home, "jingler", "models", "whisper")
  mkdirSync(models, { recursive: true })
  writeFileSync(join(models, "ggml-base.bin"), "fake")
  await openVoiceSettings(window)
  await window.getByRole("button", { name: "Language", exact: true }).click()
  await window.getByRole("option", { name: "German" }).click({ force: true })
  await window.keyboard.press("Escape")
  await window.getByRole("button", { name: "Close settings", exact: true }).click()
  await window.getByRole("button", { name: "Voice input", exact: true }).click()
  await window.waitForTimeout(800)
  await window.getByRole("button", { name: "Stop recording", exact: true }).click()
  await expect(window.getByPlaceholder("Message the agent…")).toHaveValue("add a retry to the login test", { timeout: 20_000 })
  expect(readFileSync(join(tmpdir(), "voice-args.log"), "utf8")).toContain("-l de")
  rmSync(join(tmpdir(), "voice-args.log"), { force: true })
})
