import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { appShell, expect, sessionRow, test, type SeedSession } from "./fixtures.js"

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
  await expect(window.getByText("Provider connections", { exact: true })).toBeVisible()
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
  await expect(window.getByRole("region", { name: "Code review changes" })).toBeVisible()
  await window.getByRole("button", { name: "Chat 1", exact: true }).click()
  await recovery.getByRole("button", { name: /Mark inspected/ }).click()
  await expect(recovery).toHaveCount(0)
})
