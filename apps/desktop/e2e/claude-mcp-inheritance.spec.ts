import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { appShell, expect, test } from "./fixtures.js"

const claudeBinary = join(import.meta.dirname, "fake-claude-mcp-cli.mjs")
const paperServer = join(import.meta.dirname, "fake-paper-mcp.mjs")
const sessions = ({ repoPath }: { repoPath: string }) => [{
  id: "s_claude_mcp",
  repo: "widget",
  branch: "chore/claude-mcp",
  title: "Claude MCP",
  status: "idle" as const,
  diff: { added: 0, removed: 0 },
  prNumber: null,
  costUsd: 0,
  tokens: 0,
  updatedAt: "2026-09-13T00:00:00.000Z",
  worktreePath: repoPath,
  baseBranch: "main"
}]

test("a Claude CLI connection uses a named Jingler MCP service", async ({ launchApp }) => {
  const { window } = await launchApp({
    configured: true,
    withRepo: true,
    sessions,
    piFixture: {
      scenarioId: "named-mcp",
      authRoute: "claude-setup-token"
    },
    e2eEnv: { JINGLER_CLAUDE_BINARY: claudeBinary },
    seed: ({ home }) => {
      const root = join(home, "jingler")
      mkdirSync(root, { recursive: true })
      writeFileSync(join(root, "mcp.json"), JSON.stringify({
        mcp: {
          paper: {
            type: "local",
            command: [process.execPath, paperServer],
            environment: { PAPER_TOKEN: "paper-e2e-secret" },
            enabled: true
          }
        }
      }))
    }
  })
  await expect(appShell(window)).toBeVisible()

  const composer = window.getByPlaceholder("Message the agent…")
  await composer.fill("Using Paper, inspect the current app design.")
  await composer.press("Enter")

  await expect(window.getByText(
    "Claude used the inherited Paper MCP through Jingler."
  )).toBeVisible({ timeout: 20_000 })
  await expect(window.getByText(
    "Claude did not receive the Paper MCP result."
  )).toHaveCount(0)
})
