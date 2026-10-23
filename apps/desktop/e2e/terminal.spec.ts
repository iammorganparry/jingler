import { appShell, expect, test } from "./fixtures.js"
import type { SeedSession } from "./fixtures.js"

/**
 * The native PTY terminal, end to end against the built app. Unlike the agent,
 * the terminal has NO scripted mode — it spawns a REAL login shell in the
 * session's worktree — so we drive it with deterministic input and assert on the
 * tab's React chrome (tabs, the "last exit" footer), NOT on the xterm buffer:
 * xterm renders its text to a WebGL canvas that isn't in the DOM.
 *
 * What this proves end to end: the Terminal view mounts and auto-spawns a shell, the
 * `+` button creates another, keystrokes reach the PTY over IPC, and the PTY's
 * exit propagates back through the `Terminal.attach` stream into the UI.
 */

const seededSessions = ({ repoPath }: { repoPath: string }): ReadonlyArray<SeedSession> => [
  {
    id: "s_seeded",
    repo: "widget",
    branch: "chore/refactor",
    title: "Refactor auth flow",
    status: "idle",
    diff: { added: 0, removed: 0 },
    prNumber: null,
    costUsd: 0,
    tokens: 0,
    updatedAt: "2026-07-11T00:00:00.000Z",
    // The terminal's cwd is the session's worktree — a real git repo here.
    worktreePath: repoPath,
    mode: "accept-edits"
  }
]

test("opens Terminal as a view tab and its `+` button adds another shell", async ({ launchApp }) => {
  const { window } = await launchApp({
    configured: true,
    isolateSystemHome: true,
    withRepo: true,
    sessions: seededSessions
  })

  await expect(appShell(window)).toBeVisible()
  await expect(window.locator(".xterm")).toHaveCount(0)
  await window.getByTestId("header-view-terminal").click()
  await expect(window.getByTestId("editor-tab-view-terminal")).toBeVisible()
  await expect(window.locator(".xterm").first()).toBeVisible({ timeout: 20_000 })

  // A second terminal from the dock's "New terminal" (+) affordance.
  await window.getByRole("button", { name: "New terminal" }).click()
  await expect(window.locator(".xterm")).toHaveCount(2, { timeout: 20_000 })
})

test("does not respawn a shell after the last terminal and its view tab are closed", async ({
  launchApp
}) => {
  const { window } = await launchApp({
    configured: true,
    isolateSystemHome: true,
    withRepo: true,
    sessions: seededSessions
  })

  await expect(appShell(window)).toBeVisible()
  await window.getByTestId("header-view-terminal").click()
  await expect(window.locator(".xterm").first()).toBeVisible({ timeout: 20_000 })
  await window
    .getByTestId("terminal-panel")
    .getByRole("button", { name: /^Close / })
    .click()
  await expect(window.locator(".xterm")).toHaveCount(0)
  await window.getByRole("button", { name: "Close Terminal", exact: true }).click()
  await window.getByTestId("header-view-terminal").click()
  await expect(window.locator(".xterm")).toHaveCount(0)
  await expect(window.getByLabel("New terminal")).toBeVisible()
})

test("keystrokes reach the PTY and its exit surfaces in the dock footer", async ({ launchApp }) => {
  const { window } = await launchApp({
    configured: true,
    isolateSystemHome: true,
    withRepo: true,
    sessions: seededSessions
  })

  await expect(appShell(window)).toBeVisible()
  await window.keyboard.press("Control+Backquote")

  const term = window.locator(".xterm").first()
  await expect(term).toBeVisible({ timeout: 20_000 })

  // Focus the terminal and exit the shell. `exit` cleanly ends the login shell →
  // the PTY closes with code 0 → the Terminal.attach stream emits an `exit` frame
  // → the dock footer renders "last exit 0" (real React DOM, renderer-agnostic).
  await window.getByRole("textbox", { name: "Terminal input" }).click()
  await window.waitForTimeout(300)
  await window.keyboard.type("exit 0")
  await window.keyboard.press("Enter")

  // "last exit 0" — the label + the exit code render in one footer span.
  await expect(window.getByText("last exit 0")).toBeVisible({ timeout: 20_000 })
})

test("the terminal fills the whole Terminal tab", async ({ launchApp }) => {
  const { window } = await launchApp({
    configured: true,
    isolateSystemHome: true,
    withRepo: true,
    sessions: seededSessions
  })
  await expect(appShell(window)).toBeVisible()
  await window.getByTestId("header-view-terminal").click()
  await expect(window.locator(".xterm").first()).toBeVisible({ timeout: 20_000 })
  await expect(window.getByRole("separator", { name: "Resize terminal" })).toHaveCount(0)
  const panel = await window.getByTestId("terminal-panel").boundingBox()
  const viewport = window.viewportSize() ?? (await window.evaluate(() => ({ width: innerWidth, height: innerHeight })))
  // The old bottom-anchored panel was 240px tall; filling the tab means most of the window height.
  expect(panel?.height ?? 0).toBeGreaterThan(viewport.height * 0.6)
})

test("an exited shell offers Restart, which replaces it with a live shell", async ({ launchApp }) => {
  const { window } = await launchApp({
    configured: true,
    isolateSystemHome: true,
    withRepo: true,
    sessions: seededSessions
  })
  await expect(appShell(window)).toBeVisible()
  await window.getByTestId("header-view-terminal").click()
  await expect(window.locator(".xterm").first()).toBeVisible({ timeout: 20_000 })

  await window.getByRole("textbox", { name: "Terminal input" }).click()
  await window.waitForTimeout(300)
  await window.keyboard.type("exit 3")
  await window.keyboard.press("Enter")
  await expect(window.getByText("Shell exited with code 3")).toBeVisible({ timeout: 20_000 })

  await window.getByRole("button", { name: "Restart" }).click()
  await expect(window.getByText("Shell exited with code 3")).toHaveCount(0)
  await expect(window.getByTestId("terminal-panel").getByRole("tab")).toHaveCount(1)
  await expect(window.locator(".xterm").first()).toBeVisible({ timeout: 20_000 })
})

test("closing the last terminal shows No terminals with a New terminal action", async ({ launchApp }) => {
  const { window } = await launchApp({
    configured: true,
    isolateSystemHome: true,
    withRepo: true,
    sessions: seededSessions
  })
  await expect(appShell(window)).toBeVisible()
  await window.getByTestId("header-view-terminal").click()
  await expect(window.locator(".xterm").first()).toBeVisible({ timeout: 20_000 })
  await window.getByTestId("terminal-panel").getByRole("button", { name: /^Close / }).click()

  const empty = window.getByTestId("terminal-empty")
  await expect(empty.getByText("No terminals")).toBeVisible()
  await empty.getByRole("button", { name: "New terminal" }).click()
  await expect(window.locator(".xterm").first()).toBeVisible({ timeout: 20_000 })
  await expect(window.getByTestId("terminal-empty")).toHaveCount(0)
})
