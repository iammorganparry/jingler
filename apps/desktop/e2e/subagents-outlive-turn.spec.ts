import { expect, test } from "./fixtures.js"
import type { SeedSession } from "./fixtures.js"

/**
 * Talking to the main agent must not kill its sub-agents.
 *
 * The reported bug, end to end: delegate to a handful of agents, say one more thing
 * to the chat, and every sub-agent tab dies at once. The cause was four steps deep —
 * the SDK backgrounds every `Task`, so the main agent's `result` arrived while its
 * sub-agents were still working; settling the turn there closed the ONE query all of
 * them ran inside; the renderer left `running` and dropped the stream; and
 * `runLifetime` then reaped the fiber, whose single `AbortController` took the lot.
 *
 * Every layer of that has a unit test now (`turn-continuation.test.ts`,
 * `claude-adapter-subagents.test.ts`, `run-lifetime.test.ts`,
 * `conversation-machine.test.ts`). This is the one that fails the way the operator
 * described it: against the real app, with tabs on screen, by typing.
 */

const seededSessions = ({ repoPath }: { repoPath: string }): ReadonlyArray<SeedSession> => [
  {
    id: "s_subagents",
    repo: "widget",
    branch: "starbase/subagents-outlive",
    title: "Sub-agent session",
    status: "idle",
    cli: "claude",
    diff: { added: 0, removed: 0 },
    prNumber: null,
    costUsd: 0,
    tokens: 0,
    updatedAt: "2026-07-26T10:00:00.000Z",
    worktreePath: repoPath,
    mode: "accept-edits"
  }
]

/** The two tabs the scripted `[[held-subagents]]` turn opens. */
const FIRST_TAB = /Survey the tab bar/
const SECOND_TAB = /Audit the theme tokens/

test("sub-agents outlive the main agent, and talking to it does not kill them", async ({
  launchApp
}) => {
  const { window } = await launchApp({ configured: true, withRepo: true, sessions: seededSessions })
  await expect(window.getByText("Sessions", { exact: true })).toBeVisible()

  const composer = window.getByPlaceholder("Message Claude…")
  await composer.fill("[[held-subagents]] map the UI")
  await composer.press("Enter")

  // Both tabs open, and the main agent finishes speaking while they run on. This
  // sentence used to be the last thing that happened before the tabs vanished.
  await expect(window.getByRole("button", { name: FIRST_TAB })).toBeVisible({ timeout: 15_000 })
  await expect(window.getByRole("button", { name: SECOND_TAB })).toBeVisible()
  await expect(window.getByText("Delegated to two agents.")).toBeVisible()

  // The turn is still open — the composer is in its queueing form, not idle. If it
  // were idle here, the turn had settled and the sub-agents were already doomed.
  const busyComposer = window.getByPlaceholder("Queue a message while the agent works…")
  await expect(busyComposer).toBeVisible()

  // THE MOMENT. The operator talks to the main agent mid-flight.
  await busyComposer.fill("also check the theme tokens")
  await busyComposer.press("Enter")

  // It lands in the SAME turn (a steer, not a stop-and-replay)…
  await expect(window.getByText("Noted: also check the theme tokens")).toBeVisible({
    timeout: 15_000
  })
  // …and — the whole point — both sub-agents are still there.
  await expect(window.getByRole("button", { name: FIRST_TAB })).toBeVisible()
  await expect(window.getByRole("button", { name: SECOND_TAB })).toBeVisible()

  // They then finish on their own, and the turn settles once they have.
  await expect(window.getByText("Both agents reported back.")).toBeVisible({ timeout: 15_000 })
  await expect(window.getByPlaceholder("Message Claude…")).toBeVisible()
})

test("stopping a held-open turn clears every sub-agent tab", async ({ launchApp }) => {
  // The counterpart, and the decision behind it: Stop is GLOBAL. One turn, one
  // button — so the tabs go with it rather than lingering as rows nothing will ever
  // settle, which is how a "running" tab over a dead process reads as a hang.
  const { window } = await launchApp({ configured: true, withRepo: true, sessions: seededSessions })
  await expect(window.getByText("Sessions", { exact: true })).toBeVisible()

  const composer = window.getByPlaceholder("Message Claude…")
  await composer.fill("[[held-subagents]] map the UI")
  await composer.press("Enter")
  await expect(window.getByRole("button", { name: FIRST_TAB })).toBeVisible({ timeout: 15_000 })

  await window.getByRole("button", { name: /stop/i }).first().click()

  await expect(window.getByRole("button", { name: FIRST_TAB })).toHaveCount(0)
  await expect(window.getByRole("button", { name: SECOND_TAB })).toHaveCount(0)
  await expect(window.getByPlaceholder("Message Claude…")).toBeVisible({ timeout: 15_000 })
})
