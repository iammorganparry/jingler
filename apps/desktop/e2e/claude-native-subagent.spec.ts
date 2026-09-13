import { join } from "node:path"
import { appShell, expect, test } from "./fixtures.js"

const worker = join(import.meta.dirname, "fake-subagent-process-worker.mjs")
const sessions = ({ repoPath }: { repoPath: string }) => [{
  id: "s_claude_child",
  repo: "widget",
  branch: "chore/claude-child",
  title: "Claude child",
  status: "idle" as const,
  diff: { added: 0, removed: 0 },
  prNumber: null,
  costUsd: 0,
  tokens: 0,
  updatedAt: "2026-09-12T00:00:00.000Z",
  worktreePath: repoPath,
  baseBranch: "main"
}]

test("a Claude CLI connection launches a native subagent", async ({ launchApp }) => {
  const { window } = await launchApp({
    configured: true,
    withRepo: true,
    sessions,
    piFixture: {
      scenarioId: "claude-native-subagent",
      authRoute: "claude-setup-token"
    },
    e2eEnv: {
      JINGLER_SUBAGENT_PROCESS_WORKER: worker,
      ANTHROPIC_API_KEY: "must-not-reach-child",
      ANTHROPIC_AUTH_TOKEN: "must-not-reach-child",
      ANTHROPIC_BASE_URL: "https://api.example.test",
      CLAUDE_CODE_USE_BEDROCK: "1"
    }
  })
  await expect(appShell(window)).toBeVisible()

  const composer = window.getByPlaceholder("Message the agent…")
  await composer.fill("[[supervisor-subagent]] Audit the app design with Paper.")
  await composer.press("Enter")

  await expect(window.getByText(
    "Reviewer detached promptly and is waiting for supervisor input."
  )).toBeVisible({ timeout: 20_000 })
  await expect(window.getByText(
    "Claude child completed the brokered design audit."
  )).toBeVisible()
  await expect(window.getByText(
    "Claude CLI connections are unavailable to native subagents"
  )).toHaveCount(0)
})
