/**
 * #508: a run that blocks in a session the operator isn't viewing raises a
 * "Needs you" toast whose Jump lands on the waiting question (the #506
 * landing); a run blocking in the viewed session raises none.
 */
import { appShell, expect, sessionRow, test, type SeedSession } from "./fixtures.js"

const seededSessions = ({ repoPath }: { repoPath: string }): ReadonlyArray<SeedSession> =>
  ["a", "b"].map((id, i) => ({
    id: `s_toast_${id}`,
    repo: "widget",
    branch: `feat/toast-${id}`,
    title: `Session ${id.toUpperCase()}`,
    status: "idle" as const,
    diff: { added: 0, removed: 0 },
    prNumber: null,
    costUsd: 0,
    tokens: 0,
    updatedAt: `2026-10-20T00:00:0${i}.000Z`,
    worktreePath: repoPath,
    mode: "accept-edits" as const
  }))

test("a blocked background session toasts Needs you and Jump lands on the question; the viewed session does not", async ({
  launchApp
}) => {
  const { window } = await launchApp({ configured: true, withRepo: true, sessions: seededSessions })
  await expect(appShell(window)).toBeVisible()
  const jump = window.getByRole("button", { name: /^Jump$/ })

  // Viewed session blocks: no toast.
  await sessionRow(window, "Session B").click()
  const composer = window.getByPlaceholder("Message the agent…")
  await composer.fill("[[ask]] viewed")
  await composer.press("Enter")
  await expect(window.getByText("Agent needs your input")).toBeVisible({ timeout: 15_000 })
  await expect(jump).toHaveCount(0)

  // Background session blocks: look away right after sending.
  await sessionRow(window, "Session A").click()
  await composer.fill("[[ask]] background")
  await composer.press("Enter")
  await sessionRow(window, "Session B").click()
  await expect(jump).toBeVisible({ timeout: 15_000 })

  await jump.click()
  await expect(window.getByText("Agent needs your input")).toBeVisible()
  await expect(window.locator("[data-option]").first()).toBeFocused()
})
