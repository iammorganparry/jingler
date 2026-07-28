import { appShell, expect, test } from "./fixtures.js"
import type { SeedSession } from "./fixtures.js"

/**
 * Two chats in ONE session run their agents at the same time.
 *
 * A session's chats share one git worktree, and the harness used to refuse a
 * second run while any run in the session was live — a chat B prompt came back
 * as "Another chat or plan in this session is running." This proves the refusal
 * is gone: chat A parks at a HITL gate (its run still live), chat B runs
 * concurrently to its OWN gate, and chat A's live gate is still actionable when
 * we switch back — so both runs were in flight together, not serialised.
 *
 * We assert on what the operator sees (gates, the refusal text's absence), never
 * on internals. Like Conductor's shared-workspace mode, concurrent edits are
 * allowed and unguarded — that is the feature, not a bug this test polices.
 */

const seededSessions = ({ repoPath }: { repoPath: string }): ReadonlyArray<SeedSession> => [
  {
    id: "s_parallel",
    repo: "widget",
    branch: "jingler/parallel",
    title: "Parallel chats",
    status: "idle",
    cli: "claude",
    diff: { added: 0, removed: 0 },
    prNumber: null,
    costUsd: 0,
    tokens: 0,
    updatedAt: "2026-07-24T10:00:00.000Z",
    worktreePath: repoPath,
    // accept-edits: the edit auto-applies and the run parks at the command gate,
    // giving each chat a live, still-running turn to observe.
    mode: "accept-edits"
  }
]

test("two chats in one session run their agents concurrently", async ({ launchApp }) => {
  const { window } = await launchApp({
    configured: true,
    withRepo: true,
    sessions: seededSessions
  })

  await expect(appShell(window)).toBeVisible()

  // Chat 1: start a run. In accept-edits it streams, applies the edit, then
  // parks at the command gate — its run stays LIVE, awaiting approval.
  const composer = window.getByPlaceholder("Message Claude…")
  await composer.click()
  await composer.pressSequentially("Add rate limiting to the refund endpoint.")
  await composer.press("Enter")
  await expect(window.getByText("Approval needed · run a command")).toBeVisible({ timeout: 20_000 })

  // Open a SECOND chat in the same session and run it while chat 1 is still
  // parked. Before this change the run below was refused; now it streams.
  await window.getByRole("button", { name: "New chat" }).click()
  await expect(window.getByTitle("2. Chat 2")).toHaveAttribute("aria-current", "page")

  const composer2 = window.getByPlaceholder("Message Claude…")
  await composer2.click()
  await composer2.pressSequentially("Add rate limiting to the settings endpoint.")
  await composer2.press("Enter")

  // The discriminating assertion: chat 2 genuinely ran concurrently — its own
  // turn streamed to its own command gate. Before the guard was lifted, chat 2
  // could not run while chat 1 was live, so this gate would never appear (the
  // refusal replaced its turn instead).
  await expect(window.getByText("Approval needed · run a command")).toBeVisible({ timeout: 20_000 })

  // And now that chat 2's turn has round-tripped, the refusal text is absent —
  // asserted AFTER the gate so it has had time to render had it been going to.
  await expect(window.getByText(/Another chat or plan/)).toHaveCount(0)

  // Chat 1's run survived the switch and is still live: its gate is pending and
  // actionable, which only holds if the run was never torn down for chat 2.
  // (Sending a prompt renames the chat to its first line, so the tab now reads
  // "…refund endpoint", not "Chat 1".)
  await window
    .getByRole("button", { name: "Add rate limiting to the refund endpoint.", exact: true })
    .click()
  await expect(window.getByText("Approval needed · run a command")).toBeVisible()
  await expect(window.getByRole("button", { name: /Allow once/ })).toBeVisible()

  // Approving chat 1 resolves ONLY chat 1's gate — the runs are independent.
  await window.getByRole("button", { name: /Allow once/ }).click()
  await expect(window.getByText("1 passed")).toBeVisible({ timeout: 20_000 })

  // Chat 2 is still parked at its own gate, untouched by chat 1 finishing.
  await window
    .getByRole("button", { name: "Add rate limiting to the settings endpoint.", exact: true })
    .click()
  await expect(window.getByText("Approval needed · run a command")).toBeVisible()
})
