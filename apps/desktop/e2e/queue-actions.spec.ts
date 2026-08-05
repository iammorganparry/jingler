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
    cli: "claude",
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
 * queue-only specs do not borrow plan approval now that plan messages are routed
 * directly back to the planner as revision feedback.
 */
const parkABusyRun = async (window: import("@playwright/test").Page): Promise<void> => {
  const composer = window.getByPlaceholder("Message Claude…")
  await composer.fill("[[queue-hold]] exercise queue actions")
  await composer.press("Enter")
  await expect(window.getByText("Holding the active turn for queue actions.")).toBeVisible({
    timeout: 15_000
  })
}

test("Send now turns queued plan feedback into a real revision", async ({ launchApp }) => {
  const { window } = await launchApp({
    configured: true,
    withRepo: true,
    sessions: seededSessions
  })
  await expect(appShell(window)).toBeVisible()

  const composer = window.getByPlaceholder("Message Claude…")
  await composer.fill("[[plan]] [[stream-plan]] refactor auth to a TokenStore")
  await composer.press("Enter")

  // Queue during the live draft, before a canonical plan exists. This recreates
  // the exact row from the reported bug rather than relying on a synthetic seed.
  await expect(window.getByTestId("plan-split-column")).toBeVisible({ timeout: 15_000 })
  const busyComposer = window.getByPlaceholder("Queue a message while the agent works…")
  const feedback = "Use durable objects for concurrency."
  await busyComposer.fill(feedback)
  await busyComposer.press("Enter")
  const queuedFeedback = window.getByText(feedback, { exact: true })
  await expect(queuedFeedback.locator("..").getByText("Queued", { exact: true })).toBeVisible()

  await expect(window.getByRole("button", { name: "Approve", exact: true }).first()).toBeVisible({
    timeout: 15_000
  })
  await window.getByRole("button", { name: "Send now" }).click()

  await expect(queuedFeedback).toHaveCount(0)
  await expect(window.getByText("Refactor auth flow (revised)", { exact: true })).toBeVisible({
    timeout: 20_000
  })
})

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
  await expect(window.getByTitle("1. Chat 1")).toBeVisible()
  await parkABusyRun(window)

  const busyComposer = window.getByPlaceholder("Queue a message while the agent works…")
  await busyComposer.fill("write the release notes for v2")
  await busyComposer.press("Enter")
  await expect(window.getByText("Queued", { exact: true })).toBeVisible()

  await window.getByTitle(/^Hand off/).first().click()

  // A second chat opens and becomes the active one; the message runs THERE, so it
  // is no longer queued against the busy chat.
  const handedOff = window.getByTitle("2. Chat 2")
  await expect(handedOff).toBeVisible({ timeout: 15_000 })
  await expect(handedOff).toHaveAttribute("aria-current", "page")
  await expect(window.getByText("write the release notes for v2")).toBeVisible({ timeout: 15_000 })
  await expect(window.getByText("Queued", { exact: true })).toHaveCount(0)
})
