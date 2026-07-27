import { expect, sessionRow, test } from "./fixtures.js"
import type { SeedSession } from "./fixtures.js"

/**
 * The global command palette, end to end against the built app.
 *
 * What this proves that the unit tests cannot: that ⌘K reaches a listener at all
 * inside a real Electron window (the chord is claimed in `starbase-app.tsx`'s
 * window keydown, alongside the split map), that rebinding the sidebar filter to
 * ⌘F did not simply delete it, and that an action which lives in the RENDERER —
 * the terminal dock's visibility — is genuinely reachable from a palette rendered
 * inside `@starbase/ui`. That last one is the point of the two props added for
 * it; a unit test would only ever assert the prop was called.
 */

const PLACEHOLDER = "Jump to a session or run a command…"

const seededSessions: ReadonlyArray<SeedSession> = [
  {
    id: "sess-alpha",
    repo: "widget",
    branch: "starbase/alpha",
    title: "Alpha session",
    status: "idle",
    cli: "claude",
    diff: { added: 0, removed: 0 },
    prNumber: null,
    costUsd: 0,
    tokens: 0,
    updatedAt: "2026-07-11T00:00:00.000Z",
    mode: "accept-edits"
  },
  {
    id: "sess-beta",
    repo: "widget",
    branch: "starbase/beta",
    title: "Beta session",
    status: "idle",
    cli: "claude",
    diff: { added: 0, removed: 0 },
    prNumber: null,
    costUsd: 0,
    tokens: 0,
    updatedAt: "2026-07-10T00:00:00.000Z",
    mode: "accept-edits"
  }
]

test("⌘K opens the palette and jumps to a session", async ({ launchApp }) => {
  const { window } = await launchApp({ configured: true, sessions: seededSessions })

  await expect(window.getByText("Sessions", { exact: true })).toBeVisible()
  // The newest session is the one on screen at rest, so jumping to the other is
  // an observable change rather than a coincidence.
  await expect(window.getByTestId("conversation-tab")).toContainText("Alpha session")

  await window.keyboard.press("Meta+k")
  await expect(window.getByTestId("command-palette")).toBeVisible()

  // A subsequence, not a substring: "bta" is in "Beta session" only if the fuzzy
  // matcher is the one doing the filtering.
  await window.getByPlaceholder(PLACEHOLDER).fill("bta")
  await expect(window.getByTestId("palette-item-session:sess-beta")).toBeVisible()
  await expect(window.getByTestId("palette-item-session:sess-alpha")).toBeHidden()

  await window.keyboard.press("Enter")

  await expect(window.getByTestId("command-palette")).toBeHidden()
  await expect(window.getByTestId("conversation-tab")).toContainText("Beta session")
})

test("⌘P opens the same palette, and Escape closes it", async ({ launchApp }) => {
  const { window } = await launchApp({ configured: true, sessions: seededSessions })

  await expect(window.getByText("Sessions", { exact: true })).toBeVisible()

  await window.keyboard.press("Meta+p")
  await expect(window.getByTestId("command-palette")).toBeVisible()

  await window.keyboard.press("Escape")
  await expect(window.getByTestId("command-palette")).toBeHidden()

  // Reopening starts a fresh search rather than resuming the last one.
  await window.keyboard.press("Meta+k")
  await expect(window.getByPlaceholder(PLACEHOLDER)).toHaveValue("")
})

test("⌘F still focuses the sidebar filter after the rebind", async ({ launchApp }) => {
  const { window } = await launchApp({ configured: true, sessions: seededSessions })

  await expect(window.getByText("Sessions", { exact: true })).toBeVisible()

  await window.keyboard.press("Meta+f")
  await expect(window.getByPlaceholder("Filter sessions…")).toBeFocused()
  // And it must NOT have opened the palette on the way.
  await expect(window.getByTestId("command-palette")).toBeHidden()

  // The hint beside the box says so, rather than still advertising ⌘K.
  await expect(window.getByText("⌘F", { exact: true })).toBeVisible()
})

test("toggles the terminal dock — an action the shell cannot reach on its own", async ({
  launchApp
}) => {
  const { window } = await launchApp({
    configured: true,
    withRepo: true,
    sessions: [{ ...seededSessions[0]!, worktreePath: undefined }]
  })

  await expect(window.getByText("Sessions", { exact: true })).toBeVisible()

  // The dock starts visible (see `terminal.spec.ts`), so the palette offers to
  // HIDE it — the label states the effect, not the current state.
  await window.keyboard.press("Meta+k")
  const hide = window.getByTestId("palette-item-action:toggle-terminal")
  await expect(hide).toContainText("Hide Terminal")
  await hide.click()

  await expect(window.getByTestId("command-palette")).toBeHidden()
  // Hidden, NOT unmounted — `terminal-panel.tsx` keeps the dock in the tree
  // behind `display:none` so hiding it does not kill the PTY and everything
  // running in it. Asserting a count of zero here would be asserting a bug.
  await expect(window.locator(".xterm").first()).toBeHidden()

  // Reopened, the same row now offers the inverse, and restores the dock.
  await window.keyboard.press("Meta+k")
  const show = window.getByTestId("palette-item-action:toggle-terminal")
  await expect(show).toContainText("Show Terminal")
  await show.click()
  await expect(window.locator(".xterm").first()).toBeVisible({ timeout: 20_000 })
})

test("archives the active session from the palette", async ({ launchApp }) => {
  const { window } = await launchApp({ configured: true, sessions: seededSessions })

  await expect(sessionRow(window, "Alpha session")).toBeVisible()

  await window.keyboard.press("Meta+k")
  await window.getByTestId("palette-item-action:archive-session").click()

  // Archived is a FILTER, and the default hides it — so the row leaving the
  // sidebar IS the outcome.
  await expect(sessionRow(window, "Alpha session")).toBeHidden()
})
