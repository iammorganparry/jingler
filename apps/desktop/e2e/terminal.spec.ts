import { appShell, expect, test } from "./fixtures.js"
import type { SeedSession } from "./fixtures.js"
import type { Page } from "@playwright/test"

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

const shellTab = (window: Page, name: string) => window.getByRole("tab", { name, exact: true })
const newShellFromLauncher = async (window: Page) => {
  await window.getByRole("button", { name: "New tab" }).last().click()
  await window.getByTestId("new-tab-option-terminal").click()
}

test("each shell is its own editor tab; closing one leaves the other", async ({ launchApp }) => {
  const { window } = await launchApp({
    configured: true,
    isolateSystemHome: true,
    withRepo: true,
    sessions: seededSessions
  })

  await expect(appShell(window)).toBeVisible()
  await expect(window.locator(".xterm")).toHaveCount(0)
  await window.getByTestId("header-view-terminal").click()
  await expect(shellTab(window, "zsh")).toBeVisible({ timeout: 20_000 })
  await expect(window.locator(".xterm").first()).toBeVisible({ timeout: 20_000 })

  // A second shell from the + menu is a second tab in the main tab bar.
  await newShellFromLauncher(window)
  await expect(shellTab(window, "zsh 2")).toBeVisible({ timeout: 20_000 })
  await expect(shellTab(window, "zsh")).toBeVisible()
  await expect(window.locator(".xterm")).toHaveCount(2, { timeout: 20_000 })

  // Closing one leaves the other.
  await window.getByRole("button", { name: "Close zsh 2", exact: true }).click()
  await expect(shellTab(window, "zsh 2")).toHaveCount(0)
  await expect(shellTab(window, "zsh")).toBeVisible()
  await expect(window.locator(".xterm")).toHaveCount(1)
})

test("does not respawn a shell when the last shell tab is closed", async ({
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
  await window.getByRole("button", { name: "Close zsh", exact: true }).click()
  await expect(window.locator(".xterm")).toHaveCount(0)
  await expect(shellTab(window, "zsh")).toHaveCount(0)
  // Nothing respawns on its own; only an explicit open creates a shell again.
  await window.waitForTimeout(500)
  await expect(window.locator(".xterm")).toHaveCount(0)
  await window.getByTestId("header-view-terminal").click()
  await expect(window.locator(".xterm").first()).toBeVisible({ timeout: 20_000 })
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
  await expect(shellTab(window, "zsh")).toHaveCount(1)
  await expect(shellTab(window, "zsh 2")).toHaveCount(0)
  await expect(window.locator(".xterm").first()).toBeVisible({ timeout: 20_000 })
})

test("closing the last shell tab leaves none, and the + menu opens a new one", async ({ launchApp }) => {
  const { window } = await launchApp({
    configured: true,
    isolateSystemHome: true,
    withRepo: true,
    sessions: seededSessions
  })
  await expect(appShell(window)).toBeVisible()
  await window.getByTestId("header-view-terminal").click()
  await expect(window.locator(".xterm").first()).toBeVisible({ timeout: 20_000 })
  await window.getByRole("button", { name: "Close zsh", exact: true }).click()
  await expect(shellTab(window, "zsh")).toHaveCount(0)
  await expect(window.locator(".xterm")).toHaveCount(0)

  await newShellFromLauncher(window)
  await expect(window.locator(".xterm").first()).toBeVisible({ timeout: 20_000 })
  await expect(shellTab(window, "zsh")).toBeVisible()
})
