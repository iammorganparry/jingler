import { expect, sessionRow, test } from "./fixtures.js"

/**
 * A sub-agent result that lands after the parent's turn ended must start a
 * visible turn. Before, Pi ran that turn on its own: nothing reached the chat
 * and the operator had to reprompt.
 */
test("an idle agent wakes into a visible turn when sub-agent results arrive", async ({ launchApp }) => {
  const { window } = await launchApp({
    configured: true,
    withRepo: true,
    sessions: ({ repoPath }) => [{
      id: "s_wake",
      repo: "widget",
      branch: "chore/idle-wake",
      title: "Idle wake session",
      status: "idle",
      diff: { added: 0, removed: 0 },
      prNumber: null,
      costUsd: 0,
      tokens: 0,
      updatedAt: "2026-10-11T00:00:00.000Z",
      worktreePath: repoPath
    }]
  })
  await sessionRow(window, "Idle wake session").click()
  await window.getByPlaceholder("Message the agent…").fill("delegate the survey [[background-wake]]")
  await window.getByRole("button", { name: /send/i }).click()

  await expect(window.getByText("Delegated; results will arrive after this turn.")).toBeVisible()
  await expect(window.getByText("Sub-agent results arrived")).toBeVisible({ timeout: 15_000 })
  await expect(window.getByText("Picked up the sub-agent results and continued.")).toBeVisible({ timeout: 15_000 })
})
