import { execFileSync } from "node:child_process"
import { randomUUID } from "node:crypto"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, test, type Page } from "@playwright/test"
import { _electron as electron } from "playwright"
import { createWorkspace } from "./fixtures.js"
import { MAIN_ENTRY } from "./global-setup.js"
import { realProviderTarget } from "./real-provider-targets.js"

/**
 * MCP acceptance against the real Claude CLI: add a stdio server through
 * Settings, have a Claude CLI session call it, turn it off for the chat and
 * check the next turn can't, then check claude.ai connectors reach the model.
 * JINGLER_HOME is a temp dir; HOME stays real so the operator's `claude`
 * login and claude.ai connectors are used.
 */
const model = realProviderTarget("claude")
const echoServer = join(import.meta.dirname, "fake-echo-mcp.mjs")
const ALLOW_ONCE = /Allow once/u

const claudeAiConnector = (): string | undefined => {
  try {
    const out = execFileSync("claude", ["mcp", "list"], { encoding: "utf8", timeout: 150_000 })
    return /^claude\.ai (.+?):/mu.exec(out)?.[1]
  } catch {
    return undefined
  }
}

const seedHome = (home: string): string => {
  const repo = join(home, "repos", "mcp-real")
  mkdirSync(repo, { recursive: true })
  execFileSync("git", ["init", "--quiet", repo])
  execFileSync("git", ["-C", repo, "config", "user.name", "Jingler QA"])
  execFileSync("git", ["-C", repo, "config", "user.email", "qa@jingler.test"])
  writeFileSync(join(repo, "README.md"), "# MCP real canary\n")
  execFileSync("git", ["-C", repo, "add", "README.md"])
  execFileSync("git", ["-C", repo, "commit", "--quiet", "-m", "init"])
  const root = join(home, "jingler")
  const now = new Date().toISOString()
  mkdirSync(root, { recursive: true })
  writeFileSync(join(root, "config.json"), JSON.stringify({ reposDir: join(home, "repos"), lastRepoPath: repo, createdAt: now }))
  writeFileSync(join(root, "projects.json"), JSON.stringify([
    { id: "p_mcp_real", name: "mcp-real", path: repo, availability: "available", createdAt: now, updatedAt: now }
  ]))
  return repo
}

const onboard = async (window: Page): Promise<void> => {
  const providerStep = window.getByRole("heading", { name: "Connect a model provider" })
  const importStep = window.getByRole("heading", { name: "Import existing sessions?" })
  const accountMenu = window.getByRole("button", { name: "Account menu" })
  await expect(providerStep.or(importStep).or(accountMenu)).toBeVisible({ timeout: 60_000 })
  if (await providerStep.isVisible()) {
    await window.getByRole("button", { name: "Connect Claude through PI" }).click()
    await expect.poll(() => window.getByText(model.connectionLabel, { exact: true }).count(), { timeout: 5 * 60_000 }).toBeGreaterThan(0)
    const next = window.getByRole("button", { name: "Continue" })
    await expect(next.or(importStep).or(accountMenu)).toBeVisible({ timeout: 30_000 })
    if (await next.isVisible()) await next.click()
  }
  await expect(importStep.or(accountMenu)).toBeVisible({ timeout: 30_000 })
  if (await importStep.isVisible()) await window.getByRole("button", { name: "Skip for now" }).click()
  await expect(accountMenu).toBeVisible({ timeout: 10 * 60_000 })
  const notNow = window.getByTestId("import-card").getByRole("button", { name: "Not now" })
  if (await notNow.isVisible().catch(() => false)) await notNow.click()
}

const openSettings = async (window: Page, section: string | RegExp): Promise<void> => {
  await window.getByRole("button", { name: "Account menu" }).click()
  await window.getByRole("menuitem", { name: "Settings" }).click()
  await window.getByRole("button", { name: section, exact: typeof section === "string" }).click()
}

const selectClaudeModel = async (window: Page): Promise<void> => {
  const connection = window.getByRole("button").filter({ hasText: model.connectionLabel })
  if ((await connection.count()) === 0) {
    await window.getByRole("button", { name: "Add runtime" }).click()
    await window.getByRole("button", { name: "Connect Claude through PI" }).click()
  }
  await expect(connection.first()).toBeVisible({ timeout: 5 * 60_000 })
  await connection.first().click()
  const row = window.locator(`button[title^="${model.modelId} ·"]`)
  await expect(row).toContainText(model.label)
  // Certification is advisory on main: an authenticated connection's models are usable as-is.
  if ((await row.getAttribute("aria-pressed")) !== "true") await row.click()
  await expect(row).toHaveAttribute("aria-pressed", "true")
}

/** Send a prompt, approving any MCP tool call, until `done` holds. */
const ask = async (window: Page, prompt: string, done: () => Promise<boolean>): Promise<void> => {
  const composer = window.getByPlaceholder("Message the agent…")
  await composer.fill(prompt)
  await composer.press("Enter")
  await expect.poll(async () => {
    const allow = window.getByRole("button", { name: ALLOW_ONCE }).last()
    if (await allow.isVisible().catch(() => false)) await allow.click().catch(() => {})
    return done()
  }, { timeout: 4 * 60_000, intervals: [1_000] }).toBe(true)
}

test.describe("real Claude CLI MCP", () => {
  test.skip(process.env.JINGLER_REAL_PROVIDER_QA !== "1", "Set JINGLER_REAL_PROVIDER_QA=1 to run against the local Claude CLI login.")

  test("adds an MCP server, calls it from Claude, honours per-chat off, and exposes claude.ai connectors", async () => {
    test.setTimeout(25 * 60_000)
    const connector = claudeAiConnector()
    const home = mkdtempSync(join(tmpdir(), "jingler-mcp-real-"))
    const repo = seedHome(home)
    const log = join(home, "echo-calls.jsonl")
    const calls = (): ReadonlyArray<{ nonce: string; token: string }> =>
      existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)) : []

    const app = await electron.launch({
      args: [MAIN_ENTRY, `--user-data-dir=${join(home, "chromium")}`],
      env: {
        ...process.env,
        ELECTRON_RENDERER_URL: "",
        JINGLER_DISABLE_AUTO_UPDATE: "1",
        JINGLER_E2E: "0",
        JINGLER_E2E_HEADLESS: process.env.JINGLER_E2E_HEADED === "1" ? "0" : "1",
        JINGLER_HOME: home,
        JINGLER_SCRIPTED_AGENT: "0",
        JINGLER_SECRET_STORE: ""
      }
    })
    try {
      const window = await app.firstWindow()
      await window.waitForLoadState("domcontentloaded")
      await onboard(window)

      await openSettings(window, /^Providers/u)
      await selectClaudeModel(window)

      // Adding an MCP server through the UI.
      await window.getByRole("button", { name: "MCP servers", exact: true }).click()
      await window.getByRole("button", { name: "Add server" }).first().click()
      const dialog = window.getByRole("dialog", { name: "Add MCP server" })
      await dialog.getByLabel("Server name").fill("echo")
      await dialog.getByRole("button", { name: "Server type" }).click()
      await window.getByRole("option", { name: "Local (command)" }).click()
      await dialog.getByLabel("Server command").fill(JSON.stringify([process.execPath, echoServer, log]))
      await dialog.getByRole("button", { name: "Save server" }).click()
      const yours = window.getByRole("table", { name: "MCP servers" })
      await expect(yours.getByText("echo", { exact: true })).toBeVisible({ timeout: 30_000 })
      // The claude.ai listing is slow; waiting here also warms the cache the runtime reads.
      if (connector !== undefined) await expect(yours.getByText(connector, { exact: true })).toBeVisible({ timeout: 4 * 60_000 })
      await window.getByRole("button", { name: "Close settings" }).click()

      await createWorkspace(window, "MCP real canary", "worktree", repo)
      await expect(window.getByPlaceholder("Message the agent…")).toBeVisible({ timeout: 3 * 60_000 })
      await expect(window.getByRole("button", { name: "Model settings" }).first()).toContainText(model.label, { timeout: 60_000 })

      // Using the MCP: the server records the call and returns a token only it knows.
      const first = randomUUID().slice(0, 8)
      await ask(window, `Call the echo_nonce MCP tool exactly once with nonce "${first}". Then reply with only the text the tool returned.`,
        async () => calls().some((call) => call.nonce === first))
      const token = calls().find((call) => call.nonce === first)?.token ?? ""
      await expect(window.getByText(token).last()).toBeVisible({ timeout: 3 * 60_000 })

      // Per-chat off: the next turn can't reach the server.
      await window.getByRole("button", { name: "Composer menu" }).click()
      await window.getByRole("option", { name: /^MCP/u }).click()
      const toggle = window.getByRole("switch", { name: "Use echo in this chat" })
      await toggle.click()
      await expect(toggle).not.toBeChecked()
      await window.keyboard.press("Escape")
      const second = randomUUID().slice(0, 8)
      const sentinel = `DONE-${randomUUID().slice(0, 6)}`
      await ask(window, `If you have an echo_nonce tool, call it with nonce "${second}"; if you don't, call nothing. Then reply with exactly: ${sentinel}`,
        async () => (await window.getByText(sentinel).count()) >= 2)
      expect(calls().some((call) => call.nonce === second)).toBe(false)

      // claude.ai connectors reach a Claude CLI session.
      test.skip(connector === undefined, "No claude.ai connectors on this machine's Claude login.")
      const listed = window.getByText(/mcp__claude_ai_[A-Za-z0-9]/u)
      const none = window.getByText("NONE", { exact: true })
      await ask(window, 'List the name of every tool you can call that begins with "mcp__claude_ai_". Reply with the names only, one per line, or NONE.',
        async () => (await listed.count()) > 0 || (await none.count()) > 0)
      await expect(listed.first()).toBeVisible()
    } finally {
      await app.close()
    }
  })
})
