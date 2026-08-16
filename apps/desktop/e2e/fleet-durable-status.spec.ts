import { startBetterAuthTestServer } from "@jingler/server/test-support/better-auth-account"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, test } from "./fixtures.js"

const piSessionId = "01a009ff-0000-7000-8000-000000000001"
const runId = "fleet-durable-dom-qa"
const asyncRoot = join(
  tmpdir(),
  `pi-subagents-uid-${process.getuid?.() ?? 501}`,
  "async-subagent-runs"
)

test("durable native status appears in the integrated Fleet drawer", async ({
  launchApp
}) => {
  test.setTimeout(120_000)
  const home = mkdtempSync(join(tmpdir(), "jingler-fleet-home-"))
  const reposDir = mkdtempSync(join(tmpdir(), "jingler-fleet-repos-"))
  const piSessionFile = join(home, "jingler/pi-sessions/fleet-parent.jsonl")
  const auth = await startBetterAuthTestServer()
  mkdirSync(join(asyncRoot, ".active-runs"), { recursive: true })
  mkdirSync(join(asyncRoot, runId), { recursive: true })
  writeFileSync(join(asyncRoot, ".active-runs", runId), "")
  writeFileSync(join(asyncRoot, runId, "status.json"), JSON.stringify({
    runId,
    sessionId: piSessionFile,
    mode: "workflow",
    state: "running",
    startedAt: Date.now(),
    lastUpdate: Date.now(),
    steps: [{
      agent: "scout",
      label: "main",
      workflowKey: "main",
      status: "running",
      startedAt: Date.now(),
      model: "openai-codex/gpt-5.6-sol:low"
    }]
  }))
  try {
    const { completeDeepLinkSignIn, window } = await launchApp({
      home,
      reposDir,
      configured: true,
      signedIn: false,
      authSessionServer: auth,
      withRepo: true,
      sessions: ({ repoPath }) => [{
        id: "s_fleet_durable_qa",
        repo: "widget",
        branch: "fix/fleet-durable-status-projection",
        title: "Fleet durable status QA",
        status: "idle",
        diff: { added: 0, removed: 0 },
        prNumber: null,
        costUsd: 0,
        tokens: 0,
        updatedAt: "2026-08-16T10:30:00.000Z",
        worktreePath: repoPath,
        mode: "auto",
        piSessionId: piSessionFile,
        chats: [{
          id: "c_s_fleet_durable_qa_1",
          title: "Fleet DOM QA",
          createdAt: "2026-08-16T10:30:00.000Z",
          updatedAt: "2026-08-16T10:30:00.000Z",
          mode: "auto",
          piSessionId: piSessionFile,
          connectionId: "jingler-e2e-connection",
          providerId: "jingler-e2e",
          modelId: "jingler-e2e/eval-model"
        }],
        activeChatId: "c_s_fleet_durable_qa_1"
      }],
      seed: ({ repoPath }) => {
        mkdirSync(join(home, "jingler/pi-sessions"), { recursive: true })
        writeFileSync(piSessionFile, `${JSON.stringify({
          type: "session",
          version: 3,
          id: piSessionId,
          timestamp: "2026-08-16T10:30:00.000Z",
          cwd: repoPath
        })}\n`)
      },
      e2eEnv: { JINGLER_AUTH_URL: auth.url }
    })
    await completeDeepLinkSignIn()
    const composer = window.getByPlaceholder("Message the agent…")
    await expect(composer).toBeVisible({ timeout: 30_000 })
    await composer.fill("Confirm the Fleet projection is active.")
    await composer.press("Enter")
    const fleet = window.getByTestId("fleet-drawer")
    await expect(fleet).toBeVisible({ timeout: 30_000 })
    await expect(
      window.getByTestId("composer").getByTestId("fleet-drawer")
    ).toBeVisible()
    await expect(fleet).toContainText("scout")
    const resize = fleet.getByRole("button", { name: "Resize Fleet drawer" })
    await expect(resize).toBeVisible()
    expect(await resize.evaluate((element) => {
      const style = getComputedStyle(element)
      return {
        top: style.borderTopWidth,
        bottom: style.borderBottomWidth
      }
    })).toEqual({ top: "1px", bottom: "0px" })
  } finally {
    rmSync(join(asyncRoot, ".active-runs", runId), { force: true })
    rmSync(join(asyncRoot, runId), { recursive: true, force: true })
    rmSync(home, { recursive: true, force: true })
    rmSync(reposDir, { recursive: true, force: true })
    await auth.close()
  }
})
