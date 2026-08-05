import { readFileSync } from "node:fs"
import { join } from "node:path"
import { appShell, expect, sessionRow, test } from "./fixtures.js"
import type { SeedSession } from "./fixtures.js"

/**
 * The conversation text-size setting (Settings › General › Text size), end to
 * end against the built app.
 *
 * The lever is a preset multiplier persisted as `fontScale` in config.json,
 * mirrored onto `document.documentElement` as the `--sb-font-scale` CSS custom
 * property, which the conversation + code sizes consume via `calc()`. So three
 * things must hold and are asserted here: the variable flips, the transcript
 * text actually grows, and the choice survives on disk.
 *
 * `calc(...)` rather than CSS `zoom` is load-bearing: the transcript is a
 * virtualized list, and `zoom` desyncs its measured heights from `scrollHeight`.
 * A genuine font-size change reflows, so the virtualizer re-measures — this test
 * measures the resolved `font-size`, which only moves if that path works.
 *
 * Run locally: `pnpm --filter @jingler/desktop e2e` (the `_electron` suite is
 * not in CI). Asserts on what the operator sees, never on internals.
 */

const AGENT_LINE = "It issues and verifies bearer tokens."

const session: SeedSession = {
  id: "s_textsize",
  repo: "widget",
  branch: "chore/s_textsize",
  title: "Text size demo",
  status: "idle",
  cli: "claude",
  diff: { added: 0, removed: 0 },
  prNumber: null,
  costUsd: 0,
  tokens: 0,
  updatedAt: "2026-07-16T00:00:00.000Z"
}

const conversation = [
  {
    id: "u_s_textsize_1",
    role: "user",
    parts: [{ _tag: "Text", text: "what does the auth module do" }],
    streaming: false,
    createdAt: "2026-07-16T00:00:00.000Z"
  },
  {
    id: "a_s_textsize_2",
    role: "assistant",
    parts: [{ _tag: "Text", text: AGENT_LINE }],
    streaming: false,
    createdAt: "2026-07-16T00:00:01.000Z"
  }
]

/** Resolved font-size (px) of the agent's message line, as the operator sees it. */
const agentFontSize = (window: import("@playwright/test").Page) =>
  window
    .getByText(AGENT_LINE)
    .first()
    .evaluate((element) => Number.parseFloat(getComputedStyle(element).fontSize))

test("Text size scales the conversation and persists to config", async ({ launchApp }) => {
  const app = await launchApp({
    configured: true,
    withRepo: true,
    sessions: [session],
    transcripts: { s_textsize: conversation }
  })
  const { window, home } = app

  await sessionRow(window, "Text size demo").click()
  await expect(window.getByText(AGENT_LINE)).toBeVisible()

  // Default (no saved fontScale) is the 1× no-op.
  const before = await agentFontSize(window)
  expect(before).toBeGreaterThan(0)

  // Open Settings › General and pick "Large" (1.15×) — the real operator flow.
  await expect(appShell(window)).toBeVisible()
  await window.getByRole("button", { name: "Account menu" }).click()
  await window.getByRole("menuitem", { name: "Settings" }).click()
  await expect(window.getByRole("button", { name: "Close settings" })).toBeVisible()
  await window.getByRole("button", { name: "General" }).click()
  // The presets are a shared SegmentedControl — each option is a role="tab".
  await window.getByRole("tab", { name: "Large", exact: true }).click()

  // Saved to disk under `fontScale` — survives a restart, not just this session.
  await expect
    .poll(() => {
      // The config write isn't atomic (no temp-file rename), so a poll can catch
      // a half-written file — treat an unreadable/partial read as "not yet".
      try {
        const raw = readFileSync(join(home, "jingler", "config.json"), "utf8")
        return (JSON.parse(raw) as { fontScale?: number }).fontScale
      } catch {
        return undefined
      }
    })
    .toBe(1.15)

  // Back in the conversation, the agent's line is genuinely larger than before.
  await window.getByRole("button", { name: "Close settings" }).click()
  await expect(window.getByText(AGENT_LINE)).toBeVisible()
  await expect.poll(() => agentFontSize(window)).toBeGreaterThan(before)
})
