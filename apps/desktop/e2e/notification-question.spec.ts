/**
 * #506: clicking the OS notification for a pending question must land the
 * operator back on THAT session with the question focused — not wherever they
 * happened to be looking. A real OS notification click can't be driven from
 * Playwright, so this simulates it the way main really delivers it: sending the
 * same `jingler/notification-activated` payload on the focused window's
 * `webContents` that `showNotification`'s click handler sends — see
 * `main/notifications.ts`.
 */
import { appShell, expect, sessionRow, test, type SeedSession } from "./fixtures.js"

const seededSessions = ({ repoPath }: { repoPath: string }): ReadonlyArray<SeedSession> => [
  {
    id: "s_notif_a",
    repo: "widget",
    branch: "feat/notif-a",
    title: "Session A",
    status: "idle",
    diff: { added: 0, removed: 0 },
    prNumber: null,
    costUsd: 0,
    tokens: 0,
    updatedAt: "2026-10-20T00:00:00.000Z",
    worktreePath: repoPath,
    mode: "accept-edits"
  },
  {
    id: "s_notif_b",
    repo: "widget",
    branch: "feat/notif-b",
    title: "Session B",
    status: "idle",
    diff: { added: 0, removed: 0 },
    prNumber: null,
    costUsd: 0,
    tokens: 0,
    updatedAt: "2026-10-20T00:00:01.000Z",
    worktreePath: repoPath,
    mode: "accept-edits"
  }
]

// Fixed by the scripted `[[ask]]` AskUserQuestion response in pi-fixture.ts —
// the tool call's own `id` becomes the `QuestionRequest.id` the notification's
// `turnId` has to match for the click to focus it. See `notification-target.ts`.
const QUESTION_TURN_ID = "e2e-store-migration"

test("clicking a question notification switches to that session and focuses its question", async ({
  launchApp
}) => {
  const { app, window } = await launchApp({ configured: true, withRepo: true, sessions: seededSessions })
  await expect(appShell(window)).toBeVisible()

  // Session A: ask a question while it's active.
  await sessionRow(window, "Session A").click()
  const composer = window.getByPlaceholder("Message the agent…")
  await composer.fill("[[ask]] migrate the store")
  await composer.press("Enter")
  await expect(window.getByText("Agent needs your input")).toBeVisible({ timeout: 15_000 })

  // The operator looks away: switch to Session B, which has no pending question.
  await sessionRow(window, "Session B").click()
  await expect(window.getByText("Agent needs your input")).toHaveCount(0)

  // Simulate the notification click main would deliver: the real click handler
  // sends this exact payload on the focused window's webContents.
  await app.evaluate(({ BrowserWindow }, payload) => {
    const win = BrowserWindow.getAllWindows()[0]
    win?.webContents.send("jingler/notification-activated", payload)
  }, { sessionId: "s_notif_a", kind: "needs-input", turnId: QUESTION_TURN_ID })

  // Session A is active again, and its still-pending question is focused.
  await expect(window.getByText("Agent needs your input")).toBeVisible()
  await expect(window.locator("[data-option]").first()).toBeFocused()
})
