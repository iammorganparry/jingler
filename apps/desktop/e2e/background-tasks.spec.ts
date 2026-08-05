import { expect, sessionRow, test } from "./fixtures.js"
import type { LaunchedApp, LaunchOptions, SeedSession } from "./fixtures.js"

/**
 * Background tasks end to end: work the agent starts that OUTLIVES the turn.
 *
 * The regression this whole feature answers: an agent could background a shell
 * command or a sub-agent and it would run to completion with nothing in the UI
 * to say it existed — no way to see it, no way to stop it. The scripted harness
 * starts one on `[[background]]` and then ENDS the turn while it runs on, which
 * is precisely the situation that used to be invisible.
 */

const session = (over: Partial<SeedSession> & { id: string }): SeedSession => ({
  repo: "widget",
  branch: `chore/${over.id}`,
  title: over.id,
  status: "idle",
  cli: "claude",
  diff: { added: 0, removed: 0 },
  prNumber: null,
  costUsd: 0,
  tokens: 0,
  updatedAt: "2026-07-18T00:00:00.000Z",
  ...over
})

type LaunchApp = (options?: LaunchOptions) => Promise<LaunchedApp>

const launch = (launchApp: LaunchApp, cli: SeedSession["cli"] = "claude") =>
  launchApp({
    configured: true,
    withRepo: true,
    sessions: ({ repoPath }) => [session({ id: "s_bg", title: "Background session", cli, worktreePath: repoPath })]
  })

/** Send the marker prompt that makes the scripted harness background a task. */
const startBackgroundTask = async (window: LaunchedApp["window"]) => {
  await window.getByPlaceholder(/message claude/i).fill("watch the tests [[background]]")
  await window.getByRole("button", { name: /send/i }).click()
}

/**
 * The dock mounts COLLAPSED so it never sits over the composer, so anything
 * asserting on a ROW has to open it first. The header (counts, visibility) is
 * readable without this.
 */
const expandDock = async (window: LaunchedApp["window"]) => {
  await window.getByRole("button", { name: /expand background tasks/i }).click()
}

test("a background task appears in the dock and survives the turn ending", async ({ launchApp }) => {
  const { window } = await launch(launchApp)
  await sessionRow(window, "Background session").click()
  await startBackgroundTask(window)

  // The turn finishes — the agent's reply lands — and the task is STILL listed.
  await expect(window.getByText("Started a watcher in the background.")).toBeVisible()
  await expect(window.getByTestId("background-task-dock")).toBeVisible()
  // Collapsed by default, but the header still reports the live work.
  await expect(window.getByText("1 running")).toBeVisible()
  await expect(window.locator("[data-testid^='bg-task-']")).toHaveCount(0)

  await expandDock(window)
  const row = window.locator("[data-testid^='bg-task-']").first()
  await expect(row).toContainText("Watching the test suite")
  await expect(row).toHaveAttribute("data-status", "running")
})

test("a backgrounded sub-agent gets a dock row, not an agent tab", async ({ launchApp }) => {
  // The bug this answers: the tab opens at tool_use time, before the harness has
  // said the task is backgrounded, so the same work showed up in BOTH the agent
  // tab bar and the dock. The dock owns it — it outlives the turn; the tab
  // would be wiped by the next prompt while the work carried on.
  const { window } = await launch(launchApp)
  await sessionRow(window, "Background session").click()
  await window.getByPlaceholder(/message claude/i).fill("survey it [[background-agent]]")
  await window.getByRole("button", { name: /send/i }).click()

  await expect(window.getByText("Delegated the survey to a background agent.")).toBeVisible()
  await expandDock(window)
  await expect(window.locator("[data-testid^='bg-task-']").first()).toContainText("Surveying the codebase")
  // No agent tab bar at all — the only sub-agent this turn spawned was retracted.
  await expect(window.getByRole("tab", { name: /explore/i })).toHaveCount(0)
})

test("the dock reports a running task's live progress", async ({ launchApp }) => {
  const { window } = await launch(launchApp)
  await sessionRow(window, "Background session").click()
  await startBackgroundTask(window)
  await expandDock(window)

  const row = window.locator("[data-testid^='bg-task-']").first()
  // While a task runs there is no output stream — these counters ARE the view.
  await expect(row).toContainText("12s")
  await expect(row).toContainText("3 tools")
  await expect(row).toContainText("1.2k tokens")
})

test("stopping a task settles it, and the row says so", async ({ launchApp }) => {
  const { window } = await launch(launchApp)
  await sessionRow(window, "Background session").click()
  await startBackgroundTask(window)
  await expandDock(window)

  const row = window.locator("[data-testid^='bg-task-']").first()
  await expect(row).toHaveAttribute("data-status", "running")
  await window.getByRole("button", { name: /stop watching the test suite/i }).click()

  // The scripted harness confirms the stop the way a real one does — through the
  // same settle + level signals — so the row ends in `stopped`, not `stopping`.
  await expect(row).toHaveAttribute("data-status", "stopped")
  await expect(row).toContainText("Stopped by the operator")
  // No Stop button on a settled task.
  await expect(window.getByRole("button", { name: /stop watching/i })).toHaveCount(0)
})

test("the dock is hidden for a harness with no background-task support", async ({ launchApp }) => {
  // Codex can only abort a whole turn, so a dock with a Stop button would be a
  // lie about what the operator can actually do.
  const { window } = await launch(launchApp, "codex")
  await sessionRow(window, "Background session").click()
  await window.getByPlaceholder(/message codex/i).fill("watch the tests [[background]]")
  await window.getByRole("button", { name: /send/i }).click()

  await expect(window.getByText("Started a watcher in the background.")).toBeVisible()
  await expect(window.getByTestId("background-task-dock")).toHaveCount(0)
})

test("there is no dock until something actually runs in the background", async ({ launchApp }) => {
  // An empty dock is chrome that costs attention and reports nothing.
  const { window } = await launch(launchApp)
  await sessionRow(window, "Background session").click()
  await expect(window.getByPlaceholder(/message claude/i)).toBeVisible()
  await expect(window.getByTestId("background-task-dock")).toHaveCount(0)
})

test("the chat still accepts a prompt while a background task runs on", async ({ launchApp }) => {
  // The turn that STARTED the task is over — the dock is the only thing still
  // busy. A background task is explicitly work that outlives its turn, so it must
  // not hold the chat: the operator's whole reason for backgrounding something is
  // to carry on talking while it runs.
  //
  // The failure this guards is a silent deadlock rather than an error the UI can
  // explain. The chat's run reservation is keyed on the chat id and released by a
  // finalizer on the run stream's scope; anything that leaves that scope open
  // once the turn has settled refuses every later prompt with "This chat is
  // already running" — while the composer, which follows the machine and went
  // idle on `Done`, shows a send button and no way to stop anything.
  const { window } = await launch(launchApp)
  await sessionRow(window, "Background session").click()
  await window
    .getByPlaceholder(/message claude/i)
    .fill("watch the tests [[background-live-harness]]")
  await window.getByRole("button", { name: /send/i }).click()

  // The task is running and the turn has settled.
  await expect(window.getByText("Started a watcher in the background.")).toBeVisible()
  await expect(window.getByText("1 running")).toBeVisible()

  // Now talk to the agent again.
  await window.getByPlaceholder(/message claude/i).fill("summarise the repo")
  await window.getByRole("button", { name: /send/i }).click()

  // The refusal is a `Failed` stream event, so it renders in the transcript.
  await expect(window.getByText(/This chat is already running/)).toHaveCount(0)
  await expect(
    window.getByTestId("conversation-scroll").getByText("summarise the repo")
  ).toBeVisible()
  // And the second turn actually produces a reply.
  await expect(window.getByText("src/routes/billing.ts").first()).toBeVisible({ timeout: 20_000 })
})

test("a reloaded window can still talk to a chat whose background task runs on", async ({
  launchApp
}) => {
  // The deadlock the operator actually hits, and the one the stale-reservation
  // reclaim does NOT catch.
  //
  // A chat's run reservation is released by a finalizer on the run stream's
  // scope. A renderer that goes away without interrupting the stream — a window
  // reload, an HMR full reload in `pnpm dev`, a crash — never closes that scope,
  // so main keeps the reservation. The reclaim exists for this, but it decides
  // "stranded" by asking whether the run FIBER is still alive, and a background
  // task keeps the harness session open long after the turn settled. So the fiber
  // is alive, the reclaim declines, and the chat is refused for as long as the
  // task runs — while the reloaded renderer shows an idle composer and a send
  // button, with nothing to stop.
  const { window } = await launch(launchApp)
  await sessionRow(window, "Background session").click()
  await window
    .getByPlaceholder(/message claude/i)
    .fill("watch the tests [[background-live-harness]]")
  await window.getByRole("button", { name: /send/i }).click()

  await expect(window.getByText("Started a watcher in the background.")).toBeVisible()
  await expect(window.getByText("1 running")).toBeVisible()

  // The renderer goes away without interrupting the stream.
  await window.reload()
  await sessionRow(window, "Background session").click()
  await expect(window.getByPlaceholder(/message claude/i)).toBeVisible()

  await window.getByPlaceholder(/message claude/i).fill("summarise the repo")
  await window.getByRole("button", { name: /send/i }).click()

  await expect(window.getByText(/This chat is already running/)).toHaveCount(0)
  await expect(window.getByText("src/routes/billing.ts").first()).toBeVisible({ timeout: 20_000 })
})

test("a task that finishes after its turn reports its outcome, unprompted", async ({
  launchApp
}) => {
  // "Aware of when it's done": the operator backgrounds something, carries on, and
  // the dock tells them how it went WITHOUT another prompt.
  //
  // This is the case that could not work before. A real harness reports settlement
  // through a later `task_notification`, which only arrives while the process is
  // still consuming — and the run used to be killed the moment the renderer left
  // `running` on `Done`. The row stayed "running" forever over a dead process.
  const { window } = await launch(launchApp)
  await sessionRow(window, "Background session").click()
  await window
    .getByPlaceholder(/message claude/i)
    .fill("watch the tests [[background-completes]]")
  await window.getByRole("button", { name: /send/i }).click()

  // The turn is over and the work is still going.
  await expect(window.getByText("Started a watcher in the background.")).toBeVisible()
  await expect(window.getByText("1 running")).toBeVisible()

  await expandDock(window)
  const row = window.locator("[data-testid^='bg-task-']").first()
  await expect(row).toHaveAttribute("data-status", "running")

  // Nothing is sent from here on: the outcome has to arrive on its own.
  await expect(row).toHaveAttribute("data-status", "completed", { timeout: 20_000 })
  await expect(row).toContainText("42 tests passed.")
  await expect(window.getByText("1 running")).toHaveCount(0)
})

test("the chat is usable while a task runs, and reports the task's outcome after", async ({
  launchApp
}) => {
  // The two halves together, which is what the operator actually experiences:
  // talk to the agent while the work runs, and still be told how the work ended.
  const { window } = await launch(launchApp)
  await sessionRow(window, "Background session").click()
  await window
    .getByPlaceholder(/message claude/i)
    .fill("watch the tests [[background-completes]]")
  await window.getByRole("button", { name: /send/i }).click()
  await expect(window.getByText("1 running")).toBeVisible()

  // Talk to the main agent mid-task.
  await window.getByPlaceholder(/message claude/i).fill("summarise the repo")
  await window.getByRole("button", { name: /send/i }).click()
  await expect(window.getByText(/This chat is already running/)).toHaveCount(0)
  await expect(window.getByText("src/routes/billing.ts").first()).toBeVisible({ timeout: 20_000 })

  // And the background work still reports its outcome.
  await expandDock(window)
  await expect(window.locator("[data-testid^='bg-task-']").first()).toHaveAttribute(
    "data-status",
    "completed",
    { timeout: 20_000 }
  )
})
