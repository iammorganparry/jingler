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

    // Import sheet lists user, claude.ai, plugin entries with origin labels and problems.
    const openImport = async () => {
      await window.getByRole("button", { name: "Claude", exact: true }).click()
      await window.getByRole("button", { name: "Include claude.ai connectors & plugins" }).click()
      await expect(window.getByText("claude-ai-linear", { exact: true })).toBeVisible({ timeout: 30_000 })
    }
    await openImport()
    for (const name of ["user-docs", "claude-ai-linear", "claude-ai-supabase-gtm-grid", "plugin-eng-notion"]) {
      await expect(window.getByText(name, { exact: true })).toBeVisible()
    }
    await expect(window.getByText("claude.ai", { exact: true }).first()).toBeVisible()
    await expect(window.getByText("Plugin", { exact: true }).first()).toBeVisible()
    await expect(window.getByText("User", { exact: true }).first()).toBeVisible()
    await expect(window.getByText(/Not configured/)).toBeVisible()
    await window.getByRole("button", { name: /^Import \d+ servers?$/ }).click()
    await expect(window.getByText(/^Imported /)).toBeVisible()

    const mcpJson = () => JSON.parse(readFileSync(join(home, "jingler", "mcp.json"), "utf8")).mcp as Record<string, { url?: string }>
    expect(mcpJson()["claude-ai-linear"]?.url).toBe(mcp.url)

    // Re-import is idempotent: the existing entry is flagged, nothing is overwritten.
    await openImport()
    await expect(window.getByText(/already exists/).first()).toBeVisible()
    expect(Object.keys(mcpJson()).filter((name) => name === "claude-ai-linear")).toHaveLength(1)

    // Jingler-managed OAuth against the fake server.
    await app.evaluate(({ shell }) => {
      ;(globalThis as unknown as { __opened: string[] }).__opened = []
      shell.openExternal = async (url: string) => {
        ;(globalThis as unknown as { __opened: string[] }).__opened.push(url)
      }
    })
    await window.getByRole("button", { name: "Connect" }).first().click()
    await expect.poll(() => app.evaluate(() => (globalThis as unknown as { __opened: string[] }).__opened.length)).toBe(1)
    const [authorizationUrl] = await app.evaluate(() => (globalThis as unknown as { __opened: string[] }).__opened)
    const callback = await fetch(authorizationUrl!)
    expect(await callback.text()).toContain("Connected")
    expect(mcp.registrations()).toBe(1)
    await window.getByRole("button", { name: "Close settings" }).click()

    // A Claude session reaches the imported connector through Jingler's relay.
    const composer = window.getByPlaceholder("Message the agent…")
    await composer.fill("What connectors do you have?")
    await composer.press("Enter")
    await expect(window.getByText("Claude saw the imported Linear connector.")).toBeVisible({ timeout: 30_000 })
    const args: string[] = JSON.parse(readFileSync(argsFile, "utf8"))
    expect(args).toContain("--strict-mcp-config")
    expect(args.filter((arg) => arg === "--mcp-config")).toHaveLength(1)
  } finally {
    await mcp.close()
  }
})
