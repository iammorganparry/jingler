import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { appShell, expect, test } from "./fixtures.js"

const claudeBinary = join(import.meta.dirname, "fake-claude-instructions-cli.mjs")
const sessions = ({ repoPath }: { repoPath: string }) => [{
  id: "s_claude_rules",
  repo: "widget",
  branch: "chore/claude-rules",
  title: "Claude rules",
  status: "idle" as const,
  diff: { added: 0, removed: 0 },
  prNumber: null,
  costUsd: 0,
  tokens: 0,
  updatedAt: "2026-10-09T00:00:00.000Z",
  worktreePath: repoPath,
  baseBranch: "main"
}]

test("a session sends user and project Claude rules to the agent", async ({ launchApp }) => {
  const { window } = await launchApp({
    configured: true,
    withRepo: true,
    sessions,
    piFixture: { scenarioId: "named-mcp", authRoute: "claude-setup-token" },
    e2eEnv: { JINGLER_CLAUDE_BINARY: claudeBinary },
    seed: ({ home, repoPath }) => {
      mkdirSync(join(home, ".claude", "rules"), { recursive: true })
      writeFileSync(join(home, ".claude", "rules", "org.md"), "USER_RULE_MARKER: use the provided tooling.")
      mkdirSync(join(repoPath, ".claude", "rules", "managed"), { recursive: true })
      writeFileSync(join(repoPath, ".claude", "rules", "managed", "maven.md"), "PROJECT_MANAGED_RULE_MARKER")
    }
  })
  await expect(appShell(window)).toBeVisible()

  const composer = window.getByPlaceholder("Message the agent…")
  await composer.fill("Which rules apply here?")
  await composer.press("Enter")

  await expect(window.getByText("Claude received the user and project rules.")).toBeVisible({ timeout: 20_000 })
  await expect(window.getByText(/Claude is missing instructions/)).toHaveCount(0)
})
