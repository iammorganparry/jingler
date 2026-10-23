/** Stopping a run dismisses its pending question and brings the composer back. */
import { appShell, expect, test, type SeedSession } from "./fixtures.js"

const seededSessions = ({ repoPath }: { repoPath: string }): ReadonlyArray<SeedSession> => [
  {
    id: "s_qstop",
    repo: "widget",
    branch: "feat/qstop",
    title: "Question stop",
    status: "idle",
    diff: { added: 0, removed: 0 },
    prNumber: null,
    costUsd: 0,
    tokens: 0,
    updatedAt: "2026-10-20T00:00:00.000Z",
    worktreePath: repoPath,
    mode: "accept-edits"
  }
]

test("stopping a run dismisses its pending question and restores the composer", async ({ launchApp }) => {
  const { window } = await launchApp({ configured: true, withRepo: true, sessions: seededSessions })
  await expect(appShell(window)).toBeVisible()

  await window.getByPlaceholder("Message the agent…").fill("[[ask]] migrate the store")
  await window.getByPlaceholder("Message the agent…").press("Enter")
  await expect(window.getByText("Agent needs your input")).toBeVisible({ timeout: 15_000 })

  await window.keyboard.press("Escape")

  await expect(window.getByPlaceholder("Message the agent…")).toBeVisible({ timeout: 15_000 })
  await expect(window.getByText("Agent needs your input")).toHaveCount(0)
  await expect(window.getByText("Stopped before answering")).toBeVisible()
})
