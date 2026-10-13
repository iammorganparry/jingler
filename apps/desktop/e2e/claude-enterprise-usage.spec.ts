import { join } from "node:path"
import { appShell, expect, test } from "./fixtures.js"

const claudeBinary = join(import.meta.dirname, "fake-claude-enterprise-cli.mjs")
const sessions = ({ repoPath }: { repoPath: string }) => [{
  id: "s_claude_enterprise",
  repo: "widget",
  branch: "chore/claude-enterprise",
  title: "Claude enterprise",
  status: "idle" as const,
  diff: { added: 0, removed: 0 },
  prNumber: null,
  costUsd: 0,
  tokens: 0,
  updatedAt: "2026-10-13T00:00:00.000Z",
  worktreePath: repoPath,
  baseBranch: "main"
}]

test("an API-priced Claude login runs and the usage modal shows spend, not windows", async ({ launchApp }) => {
  const { window } = await launchApp({
    configured: true,
    withRepo: true,
    sessions,
    piFixture: { scenarioId: "named-mcp", authRoute: "claude-setup-token", apiPriced: true },
    e2eEnv: { JINGLER_CLAUDE_BINARY: claudeBinary }
  })
  await expect(appShell(window)).toBeVisible()

  const composer = window.getByPlaceholder("Message the agent…")
  await composer.fill("Say hello.")
  await composer.press("Enter")
  await expect(window.getByText("Enterprise run complete.")).toBeVisible({ timeout: 20_000 })

  await window.getByRole("button", { name: "Account menu" }).click()
  await window.getByRole("menuitem", { name: /Usage & limits/ }).click()
  const dialog = window.getByRole("dialog")
  await expect(dialog.getByText("Enterprise · API pricing")).toBeVisible()
  await expect(dialog.getByTestId("spend-rows")).toContainText("$1.25")
  await expect(dialog.getByText(/% used/)).toHaveCount(0)
  await expect(dialog.getByText(/isn't available/)).toHaveCount(0)
})
