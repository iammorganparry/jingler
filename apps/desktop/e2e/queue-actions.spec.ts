import { appShell, expect, test } from "./fixtures.js"
import type { SeedSession } from "./fixtures.js"

/**
 * The queue's row actions, end to end against the built app.
 *
 * The queue used to be a list you could only cancel: a message typed while the
 * agent worked was either sent verbatim, eventually, or thrown away. These two
 * specs cover the escape hatches — rewriting a queued message before it runs, and
 * handing one to a FRESH chat when it turns out to be its own job — because both
 * change what the agent is eventually asked, which no unit test can see end to end.
 */

const seededSessions = ({ repoPath }: { repoPath: string }): ReadonlyArray<SeedSession> => [
  {
    id: "s_queue",
    repo: "widget",
    branch: "chore/queue-actions",
    title: "Queue actions",
    status: "idle",
    diff: { added: 0, removed: 0 },
    prNumber: null,
    costUsd: 0,
    tokens: 0,
    updatedAt: "2026-07-25T10:00:00.000Z",
    worktreePath: repoPath,
    mode: "accept-edits"
  }
]

/**
 * Park a run so the composer is in its queueing form.
 *
 * `[[queue-hold]]` keeps the scripted turn BUSY until the app closes, so these
 * queue-only specs use a dedicated busy turn and do not depend on planning.
 */
const parkABusyRun = async (window: import("@playwright/test").Page): Promise<void> => {
  await window.evaluate(() => localStorage.setItem("jingler:mcp-import-prompt:v1", "done"))
  await window.reload()
  const composer = window.getByPlaceholder("Message the agent…")
  await composer.fill("[[queue-hold]] exercise queue actions")
  await composer.press("Enter")
  await expect(window.getByText("Holding the active turn for queue actions.")).toBeVisible({
    timeout: 15_000
  })
}

test("a queued message can be rewritten before it is ever sent", async ({ launchApp }) => {
  const { window } = await launchApp({ configured: true, withRepo: true, sessions: seededSessions })
  await expect(appShell(window)).toBeVisible()
  await parkABusyRun(window)

  const busyComposer = window.getByPlaceholder("Queue a message while the agent works…")
  await busyComposer.fill("and then open a PR")
  await busyComposer.press("Enter")
  await expect(window.getByText("and then open a PR")).toBeVisible()

  await window.getByTitle("Edit queued message").first().click()
  const editor = window.getByRole("textbox", { name: "Edit queued message" })
  await editor.fill("and then open a DRAFT PR")
  await editor.press("Enter")

  // The row now reads back the corrected text, and the original is gone — an edit
  // that left the old text queued would send the wrong thing minutes later, with
  // the UI claiming otherwise.
  await expect(window.getByText("and then open a DRAFT PR")).toBeVisible()
  await expect(window.getByText("and then open a PR", { exact: true })).toHaveCount(0)
})

test("a queued message can be handed off to a fresh chat", async ({ launchApp }) => {
  const { window } = await launchApp({ configured: true, withRepo: true, sessions: seededSessions })
  await expect(appShell(window)).toBeVisible()
  await expect(window.getByRole("tab", { name: "Chat 1", exact: true })).toBeVisible()
  await parkABusyRun(window)

  const busyComposer = window.getByPlaceholder("Queue a message while the agent works…")
  await busyComposer.fill("write the release notes for v2")
  await busyComposer.press("Enter")
  await expect(window.getByText("Queued", { exact: true })).toBeVisible()

  await window.getByTitle(/^Hand off/).first().click()

  // A second chat opens beside the main chat; the message runs THERE, so it
  // is no longer queued against the busy chat.
  const handedOff = window.getByRole("tab", { name: "Chat 2", exact: true })
  await expect(handedOff).toBeVisible({ timeout: 15_000 })
  await expect(handedOff).toHaveAttribute("aria-selected", "true")
  await expect(window.getByText("write the release notes for v2")).toBeVisible({ timeout: 15_000 })
  await expect(window.getByText("Queued", { exact: true })).toHaveCount(0)
  // The handoff opens beside main as its own tab; main keeps holding its turn.
  await window.locator('[data-testid^="editor-tab-chat-"]').first().getByRole("tab").click()
  await expect(window.getByText("Holding the active turn for queue actions.").filter({ visible: true })).toBeVisible()
})

test("repeated queued handoffs never hide main", async ({ launchApp }) => {
  const { window } = await launchApp({ configured: true, withRepo: true, sessions: seededSessions })
  await expect(appShell(window)).toBeVisible()
  await parkABusyRun(window)
  const main = window.locator("[data-surface]").filter({ hasText: "Holding the active turn for queue actions." }).first()
  const mainKey = await main.getAttribute("data-surface")
  const mainBody = window.locator(`[data-surface=${JSON.stringify(mainKey)}]`)
  // The main chat auto-titles from its prompt, so address its tab by id.
  const [, mainChatId] = JSON.parse(mainKey!) as [string, string, null]
  const mainTab = window.getByTestId(`editor-tab-chat-${mainChatId}`).getByRole("tab")
  for (let i = 0; i < 4; i++) {
    // Each handoff opens its chat as a new tab; bring main back to queue the next.
    await mainTab.click()
    const composer = mainBody.getByPlaceholder("Queue a message while the agent works…")
    await composer.fill(`[[queue-hold]] handed off ${i}`)
    await composer.press("Enter")
    await mainBody.getByTitle(/^Hand off/).first().click()
    await expect(window.getByRole("tab", { name: `Chat ${i + 2}`, exact: true })).toBeVisible({ timeout: 15_000 })
    await expect(mainTab).toBeVisible()
    await expect(mainBody.getByText("Queued", { exact: true })).toHaveCount(0)
  }
  await window.getByTestId(`editor-tab-chat-${mainChatId}`).getByRole("button", { name: /^Close / }).click()
  await expect(mainTab).toHaveCount(0)
})
