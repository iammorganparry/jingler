import { expect, sessionRow, test } from "./fixtures.js"
import type { SeedSession } from "./fixtures.js"

/**
 * The global command palette, end to end against the built app.
 *
 * What this proves that the unit tests cannot: that ⌘K reaches a listener at all
 * inside a real Electron window (the chord is claimed in `jingler-app.tsx`'s
 * window keydown, alongside the split map), that rebinding the sidebar filter to
 * ⌘F did not simply delete it, and that an action which lives in the RENDERER —
 * the terminal dock's visibility — is genuinely reachable from a palette rendered
 * inside `@jingler/ui`. That last one is the point of the two props added for
 * it; a unit test would only ever assert the prop was called.
 */

const PLACEHOLDER = "Jump to a session or run a command…"

const seededSessions: ReadonlyArray<SeedSession> = [
  {
    id: "sess-alpha",
    repo: "widget",
    branch: "jingler/alpha",
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
    branch: "jingler/beta",
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

/**
 * Close and reopen faster than the exit animation, twice.
 *
 * The palette now survives its own close so it can fade out, which introduces a
 * failure mode it did not have before: the leaving card and the arriving one can
 * both be mounted, giving two inputs and two of every row. `AnimatePresence
 * mode="wait"` is what prevents it, and this is the test that would notice if it
 * were ever dropped for the default `sync`.
 *
 * Deliberately no `toBeHidden()` between the two presses — waiting for the exit
 * is exactly what would stop this reproducing.
 */
test("reopening mid-exit leaves exactly one palette", async ({ launchApp }) => {
  const { window } = await launchApp({ configured: true, sessions: seededSessions })
  await expect(window.getByText("Sessions", { exact: true })).toBeVisible()

  for (let i = 0; i < 2; i++) {
    await window.keyboard.press("Meta+k")
    await expect(window.getByTestId("command-palette")).toBeVisible()
    await window.keyboard.press("Escape")
    await window.keyboard.press("Meta+k")
    await expect(window.locator("[data-testid='command-palette']")).toHaveCount(1)
  }

  // One input, and it is usable — a strict-mode violation here would mean two.
  await window.getByPlaceholder(PLACEHOLDER).fill("Beta")
  await expect(window.getByTestId("palette-item-session:sess-beta")).toBeVisible()
})

test("⌘F still focuses the sidebar filter after the rebind", async ({ launchApp }) => {
  const { window } = await launchApp({ configured: true, sessions: seededSessions })

  // Wait on the input itself, not just the "Sessions" heading. The heading
  // paints before the sidebar is interactive, and a chord pressed into that gap
  // is simply lost — which is what made this the one flaky test in the file.
  const filter = window.getByPlaceholder("Filter sessions…")
  await expect(filter).toBeVisible()

  await window.keyboard.press("Meta+f")
  await expect(filter).toBeFocused()
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
  // `toContainText` also settles the open spring before the click — see the note
  // in the "Go to <Tab>" test below.
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

/**
 * The chord is ⌘ on macOS and Ctrl elsewhere, NOT either-or.
 *
 * Ctrl+K and Ctrl+P are Cocoa caret bindings Chromium implements in every macOS
 * text field — kill-line and previous-line — so accepting bare Ctrl here would
 * take both away from the composer and pop a modal instead, on the one platform
 * where ⌘K already works.
 */
test("does not hijack Ctrl+K from macOS text fields", async ({ launchApp }) => {
  test.skip(process.platform !== "darwin", "the Ctrl/⌘ split only bites on macOS")

  const { window } = await launchApp({ configured: true, sessions: seededSessions })
  await expect(window.getByText("Sessions", { exact: true })).toBeVisible()

  await window.keyboard.press("Control+k")
  await expect(window.getByTestId("command-palette")).toBeHidden()
  await window.keyboard.press("Control+p")
  await expect(window.getByTestId("command-palette")).toBeHidden()

  // …and the real chord still works, so this is a narrowing rather than a break.
  await window.keyboard.press("Meta+k")
  await expect(window.getByTestId("command-palette")).toBeVisible()
})

/**
 * Switching sessions after a "Go to <Tab>" must not carry the tab with it.
 *
 * A pane is keyed by session id and remounts on every switch, so an uncleared
 * request is replayed onto the next session's first render — one "Go to
 * Changes" would open everything you visited afterwards on Changes, which reads
 * as the palette having changed a setting rather than performed an action.
 */
test("a 'Go to <Tab>' does not follow you to the next session", async ({ launchApp }) => {
  const { window } = await launchApp({
    configured: true,
    withRepo: true,
    sessions: ({ repoPath }) => [
      { ...seededSessions[0]!, worktreePath: repoPath },
      { ...seededSessions[1]!, worktreePath: repoPath }
    ]
  })

  await expect(window.getByTestId("conversation-tab")).toContainText("Alpha session")

  // A worktree with no PR surfaces the Changes tab — see `builtinTabContributions`.
  await window.keyboard.press("Meta+k")
  // Waiting on the row explicitly rather than letting `click()`'s actionability
  // check do it: the card springs in on open, and a click that lands mid-spring
  // reports as a stability timeout on a line that says nothing about animation.
  const changes = window.getByTestId("palette-item-tab:changes")
  await expect(changes).toBeVisible()
  await changes.click()
  await expect(window.getByRole("button", { name: "Changes" })).toHaveAttribute(
    "aria-current",
    "page"
  )

  // Jump to the other session. It must arrive on Conversation.
  await window.keyboard.press("Meta+k")
  await window.getByPlaceholder(PLACEHOLDER).fill("Beta")
  await window.keyboard.press("Enter")

  await expect(window.getByTestId("conversation-tab")).toContainText("Beta session")
  // `aria-current` is absent, not "false", when a tab is not the active one.
  await expect(window.getByRole("button", { name: "Changes" })).not.toHaveAttribute(
    "aria-current",
    "page"
  )
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
