import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { appShell, expect, test } from "./fixtures.js"
import { startFakeOAuthMcpServer } from "./fake-oauth-mcp-server.js"

const claudeBinary = join(import.meta.dirname, "fake-claude-connectors-cli.mjs")
const sessions = ({ repoPath }: { repoPath: string }) => [{
  id: "s_claudeai_mcp",
  repo: "widget",
  branch: "chore/claudeai-mcp",
  title: "claude.ai MCP",
  status: "idle" as const,
  diff: { added: 0, removed: 0 },
  prNumber: null,
  costUsd: 0,
  tokens: 0,
  updatedAt: "2026-10-15T00:00:00.000Z",
  worktreePath: repoPath,
  baseBranch: "main"
}]

test("imports claude.ai connectors and plugin MCPs, signs in, and exposes them to Claude", async ({ launchApp }) => {
  const mcp = await startFakeOAuthMcpServer()
  const argsFile = join(tmpdir(), `claudeai-args-${process.pid}-${Date.now()}.json`)
  try {
    const { window, app, home } = await launchApp({
      configured: true,
      withRepo: true,
      sessions,
      piFixture: { scenarioId: "named-mcp", authRoute: "claude-setup-token" },
      e2eEnv: {
        JINGLER_CLAUDE_BINARY: claudeBinary,
        FAKE_CLAUDE_MCP_URL: mcp.url,
        FAKE_CLAUDE_ARGS_FILE: argsFile
      },
      seed: ({ home: root }) => {
        mkdirSync(root, { recursive: true })
        writeFileSync(join(root, ".claude.json"), JSON.stringify({
          mcpServers: { "user-docs": { type: "http", url: "https://docs.example/mcp" } }
        }))
      }
    })
    await expect(appShell(window)).toBeVisible()
    const notNow = window.getByTestId("import-card").getByRole("button", { name: "Not now" })
    if (await notNow.isVisible().catch(() => false)) await notNow.click()

    await window.getByRole("button", { name: "Account menu" }).click()
    await window.getByRole("menuitem", { name: "Settings" }).click()
    await window.getByRole("button", { name: "MCP servers" }).click()

    await window.getByRole("tab", { name: "Discover" }).click()

    // claude.ai connectors run natively: real auth state from `claude mcp list`, never importable.
    const native = window.getByRole("region", { name: "claude.ai servers" })
    await expect(native.getByText("Linear", { exact: true })).toBeVisible({ timeout: 30_000 })
    await expect(native.getByRole("button", { name: "Connect" })).toBeVisible()
    await expect(native.getByText("Native", { exact: true })).toBeVisible()

    // Claude Code section lists user and plugin servers; not-configured plugins are hidden.
    const claudeCode = window.getByRole("region", { name: "Claude Code servers" })
    await expect(claudeCode.getByText("user-docs", { exact: true })).toBeVisible({ timeout: 30_000 })
    await expect(claudeCode.getByText("plugin-eng-notion", { exact: true })).toBeVisible()
    await expect(claudeCode.getByText(/google-calendar/)).toHaveCount(0)
    await expect(claudeCode.getByText("claude-ai-linear", { exact: true })).toHaveCount(0)
    await claudeCode.getByRole("button", { name: "Import plugin-eng-notion" }).click()

    const mcpJson = () => {
      try {
        return JSON.parse(readFileSync(join(home, "jingler", "mcp.json"), "utf8")).mcp as Record<string, { url?: string }>
      } catch {
        return {} as Record<string, { url?: string }>
      }
    }
    await expect.poll(() => mcpJson()["plugin-eng-notion"]?.url).toBe(mcp.url)
    expect(mcpJson()["claude-ai-linear"]).toBeUndefined()
    // Once imported, the card flips to its state instead of offering Import again.
    await expect(claudeCode.getByRole("button", { name: "Import plugin-eng-notion" })).toHaveCount(0, { timeout: 15_000 })
    expect(Object.keys(mcpJson()).filter((name) => name === "plugin-eng-notion")).toHaveLength(1)

    // Yours: the plugin row reconnects through Jingler-managed OAuth.
    await window.getByRole("tab", { name: "Yours" }).click()
    await app.evaluate(({ shell }) => {
      ;(globalThis as unknown as { __opened: string[] }).__opened = []
      shell.openExternal = async (url: string) => {
        ;(globalThis as unknown as { __opened: string[] }).__opened.push(url)
      }
    })
    await window.getByRole("button", { name: "Reconnect plugin:eng:notion" }).click()
    await expect.poll(() => app.evaluate(() => (globalThis as unknown as { __opened: string[] }).__opened.length)).toBe(1)
    const [authorizationUrl] = await app.evaluate(() => (globalThis as unknown as { __opened: string[] }).__opened)
    const callback = await fetch(authorizationUrl!)
    expect(await callback.text()).toContain("Connected")
    expect(mcp.registrations()).toBe(1)
    // Reconnect opens the server's drawer so sign-in errors show beside it; it reports the result.
    const drawer = window.getByRole("dialog", { name: "plugin:eng:notion" })
    await expect(drawer.getByText("Connected", { exact: true })).toBeVisible()
    await drawer.getByRole("button", { name: "Close", exact: true }).click()
    await window.getByRole("button", { name: "Close settings" }).click()

    // A Claude session reaches the imported connector through Jingler's relay.
    const composer = window.getByPlaceholder("Message the agent…")
    await composer.fill("What connectors do you have?")
    await composer.press("Enter")
    await expect(window.getByText("Claude saw the imported Notion plugin.")).toBeVisible({ timeout: 30_000 })
    const args: string[] = JSON.parse(readFileSync(argsFile, "utf8"))
    // claude.ai connectors remain, so the session loads them natively instead of running strict.
    expect(args).not.toContain("--strict-mcp-config")
    expect(args[args.indexOf("--setting-sources") + 1]).toBe("user")
    const overlay = JSON.parse(args[args.indexOf("--settings") + 1]!)
    expect(overlay.disableAllHooks).toBe(true)
    expect(overlay.deniedMcpServers.map(({ serverName }: { serverName: string }) => serverName)).toContain("plugin:eng:notion")
    expect(args[args.indexOf("--allowedTools") + 1]).toContain("mcp__claude_ai_*")
    expect(args.filter((arg) => arg === "--mcp-config")).toHaveLength(1)
  } finally {
    await mcp.close()
  }
})
