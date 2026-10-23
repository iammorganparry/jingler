import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { appShell, expect, sessionRow, test, type SeedSession } from "./fixtures.js"

const INTERRUPTED_SESSION_ID = "s_interrupted_recovery"
const INTERRUPTED_CHAT_ID = "c_interrupted_recovery"

const interruptedSeedSession = (repoPath: string): SeedSession => ({
  id: INTERRUPTED_SESSION_ID,
  repo: "widget",
  branch: "jingler/interrupted-recovery",
  title: "Mid-run recovery",
  status: "idle",
  diff: { added: 0, removed: 0 },
  prNumber: null,
  costUsd: 0,
  tokens: 0,
  updatedAt: "2026-08-10T12:00:00.000Z",
  worktreePath: repoPath,
  mode: "accept-edits"
})

const SESSION_ID = "s_runtime_recovery"
const CHAT_ID = "c_runtime_recovery"

const seededSession = (repoPath: string, recovery: boolean): SeedSession => ({
  id: SESSION_ID,
  repo: "widget",
  branch: "jingler/runtime-recovery",
  title: recovery ? "Uncertain mutation" : "Migrated connection",
  status: "idle",
  diff: { added: recovery ? 1 : 0, removed: 0 },
  prNumber: null,
  costUsd: 0,
  tokens: 0,
  updatedAt: "2026-08-10T12:00:00.000Z",
  worktreePath: repoPath,
  chats: [{
    id: CHAT_ID,
    title: null,
    createdAt: "2026-08-10T12:00:00.000Z",
    updatedAt: "2026-08-10T12:00:00.000Z"
  }],
  activeChatId: CHAT_ID,
  connectionSelectionRequired: !recovery,
  modelSelectionRequired: !recovery,
  ...(recovery
    ? {
        runtimeRecovery: {
          uncertainMutations: [{
            runId: "run-1",
            callId: "call-1",
            chatId: CHAT_ID,
            toolId: "workspace.edit",
            targetCategory: "workspace",
            startedAt: "2026-08-10T12:00:00.000Z",
            fileChangeSetIds: []
          }]
        }
      }
    : {})
})

test("opens provider recovery for a migrated session", async ({ launchApp }) => {
  const { window } = await launchApp({
    configured: true,
    config: { providerSetupCompleted: true },
    withRepo: true,
    piFixture: { scenarioId: "runtime-recovery", authRoute: "api-key", seedConnection: false },
    sessions: ({ repoPath }) => [seededSession(repoPath, false)]
  })

  await expect(appShell(window)).toBeVisible()
  await sessionRow(window, "Migrated connection").click()
  const recovery = window.getByRole("region", { name: "Runtime recovery" }).filter({
    hasText: "Choose a runtime connection"
  })
  await expect(recovery).toBeVisible()
  await recovery.getByRole("button", { name: /Open providers/ }).click()
  await expect(window.getByRole("heading", { name: "Providers", exact: true })).toBeVisible()
})

test("inspects and acknowledges an uncertain mutation without replay", async ({ launchApp }) => {
  const { window } = await launchApp({
    configured: true,
    withRepo: true,
    sessions: ({ repoPath }) => [seededSession(repoPath, true)],
    seed: ({ home, repoPath }) => {
      writeFileSync(join(repoPath, "recovered-change.ts"), "export const recovered = true\n")
      const journalDir = join(home, "jingler", "runtime", "journals")
      mkdirSync(journalDir, { recursive: true })
      writeFileSync(join(journalDir, "run-1.json"), JSON.stringify([{
        callId: "call-1",
        runId: "run-1",
        sessionId: SESSION_ID,
        chatId: CHAT_ID,
        toolId: "workspace.edit",
        risk: "mutate",
        targetCategory: "workspace",
        status: "uncertain",
        startedAt: "2026-08-10T12:00:00.000Z",
        settledAt: "2026-08-10T12:01:00.000Z",
        resultSummary: null,
        failureCode: "process-restarted-before-settle",
        fileChangeSetIds: [],
        safeToRetry: false
      }]))
    }
  })

  await expect(appShell(window)).toBeVisible()
  await sessionRow(window, "Uncertain mutation").click()
  const recovery = window.getByRole("region", { name: "Runtime recovery" }).filter({
    hasText: "Inspect an uncertain workspace mutation"
  })
  await expect(recovery).toContainText("workspace.edit")
  await recovery.getByRole("button", { name: "Inspect changes" }).click()
  await expect(window.getByRole("region", { name: "Changed files tree" })).toBeVisible()
  await expect(window.getByRole("treeitem", { name: /recovered-change\.ts/ })).toBeVisible()
  await expect(window.getByTestId("chat-lane-header")).toBeVisible()
  await recovery.getByRole("button", { name: /Mark inspected/ }).click()
  await expect(recovery).toHaveCount(0)
})

test("shows Interrupted after a kill mid-run and Resume continues the run", async ({ launchApp }) => {
  const first = await launchApp({
    configured: true,
    withRepo: true,
    sessions: ({ repoPath }) => [interruptedSeedSession(repoPath)]
  })
  await expect(appShell(first.window)).toBeVisible()
  await sessionRow(first.window, "Mid-run recovery").click()

  // `[[queue-hold]]` parks the scripted turn on a tool call that sleeps for two
  // minutes — long enough to kill the app while the run is still "in flight",
  // which is the only way a transcript ends up with a dangling `streaming`
  // message (see `findInterruptedChats`).
  const composer = first.window.getByPlaceholder("Message the agent…")
  await composer.fill("[[queue-hold]] start a long-running turn")
  await composer.press("Enter")
  await expect(first.window.getByText("Holding the active turn for queue actions.")).toBeVisible({
    timeout: 15_000
  })

  // A real restart, not `app.close()`: SIGKILL leaves no chance for main to
  // flush a clean "Done"/"Failed" onto the transcript, which is the whole point.
  await first.app.process().kill("SIGKILL")

  const resumed = await launchApp({
    home: first.home,
    reposDir: first.reposDir,
    userDataDir: first.userDataDir,
    configured: true,
    withRepo: true
  })
  await expect(appShell(resumed.window)).toBeVisible()
  await expect(sessionRow(resumed.window, "Mid-run recovery")).toContainText("Interrupted")

  await sessionRow(resumed.window, "Mid-run recovery").click()
  const interruptedCard = resumed.window.getByRole("region", { name: "Interrupted run" })
  await expect(interruptedCard).toBeVisible()
  await interruptedCard.getByRole("button", { name: "Resume" }).click()

  // Resuming sends a fresh "Continue" turn; the card clears immediately (it only
  // shows while idle) and the composer goes back to busy, then settles — both are
  // only true if the run actually continued rather than staying stuck.
  await expect(interruptedCard).toHaveCount(0)
  await expect(resumed.window.getByPlaceholder("Message the agent…")).toBeVisible({ timeout: 15_000 })
  await expect(sessionRow(resumed.window, "Mid-run recovery")).not.toContainText("Interrupted")
})
