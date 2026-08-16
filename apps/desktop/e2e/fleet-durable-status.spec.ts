import { startBetterAuthTestServer } from "@jingler/server/test-support/better-auth-account"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
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
  const childSessionFile = join(
    home,
    "jingler/pi-sessions/fleet-parent/child/run-0/session.jsonl"
  )
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
      model: "openai-codex/gpt-5.6-sol:low",
      runId: "child-run",
      sessionFile: childSessionFile
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
        mkdirSync(join(childSessionFile, ".."), { recursive: true })
        const childEntries = [
          {
            type: "session",
            version: 3,
            id: "01a009ff-0000-7000-8000-000000000002",
            timestamp: "2026-08-16T10:30:01.000Z",
            cwd: repoPath
          },
          {
            type: "message",
            id: "child-user",
            parentId: null,
            timestamp: "2026-08-16T10:30:02.000Z",
            message: {
              role: "user",
              content: "Inspect the repository",
              timestamp: 1_786_877_802_000
            }
          },
          {
            type: "message",
            id: "child-assistant",
            parentId: "child-user",
            timestamp: "2026-08-16T10:30:03.000Z",
            message: {
              role: "assistant",
              content: [{
                type: "toolCall",
                id: "child-tool",
                name: "command_execute",
                arguments: { command: "pnpm test" }
              }],
              api: "openai-codex-responses",
              provider: "openai-codex",
              model: "gpt-5.6-sol",
              usage: {
                input: 1,
                output: 1,
                cacheRead: 0,
                cacheWrite: 0,
                totalTokens: 2,
                cost: {
                  input: 0,
                  output: 0,
                  cacheRead: 0,
                  cacheWrite: 0,
                  total: 0
                }
              },
              stopReason: "toolUse",
              timestamp: 1_786_877_803_000
            }
          },
          {
            type: "message",
            id: "child-result",
            parentId: "child-assistant",
            timestamp: "2026-08-16T10:30:04.000Z",
            message: {
              role: "toolResult",
              toolCallId: "child-tool",
              toolName: "command_execute",
              content: [{
                type: "text",
                text: JSON.stringify({
                  command: "pnpm test",
                  exitCode: 0,
                  stdout: "18 tests passed"
                })
              }],
              isError: false,
              timestamp: 1_786_877_804_000
            }
          },
          {
            type: "message",
            id: "child-final",
            parentId: "child-result",
            timestamp: "2026-08-16T10:30:05.000Z",
            message: {
              role: "assistant",
              content: [{
                type: "text",
                text: Array.from(
                  { length: 120 },
                  (_, index) => `Scout output line ${index + 1}`
                ).join("\n")
              }],
              api: "openai-codex-responses",
              provider: "openai-codex",
              model: "gpt-5.6-sol",
              usage: {
                input: 1,
                output: 1,
                cacheRead: 0,
                cacheWrite: 0,
                totalTokens: 2,
                cost: {
                  input: 0,
                  output: 0,
                  cacheRead: 0,
                  cacheWrite: 0,
                  total: 0
                }
              },
              stopReason: "stop",
              timestamp: 1_786_877_805_000
            }
          }
        ]
        writeFileSync(
          childSessionFile,
          `${childEntries.map((entry) => JSON.stringify(entry)).join("\n")}\n`
        )
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
    await expect(fleet).toContainText("1 active · 1 total")
    const resize = fleet.getByRole("button", { name: "Resize Fleet drawer" })
    await expect(resize).toBeVisible()
    expect(await resize.evaluate((element) => {
      const style = getComputedStyle(element)
      return {
        top: style.borderTopWidth,
        bottom: style.borderBottomWidth
      }
    })).toEqual({ top: "1px", bottom: "0px" })

    await fleet.getByTestId("fleet-agent-child-run").click()
    const childView = window.getByTestId("fleet-agent-transcript")
    await expect(childView).toBeVisible()
    await expect(childView.getByText("pnpm test")).toBeVisible()
    await expect(childView.getByText(/Tool result \(command_execute\)/)).toHaveCount(0)
    await childView.getByRole("button", { expanded: false }).click()
    await expect(childView.getByText("18 tests passed")).toBeVisible()
    const transcriptScroll = childView.getByTestId("fleet-agent-transcript-scroll")
    const bottom = await transcriptScroll.evaluate((element) => {
      element.scrollTop = element.scrollHeight
      return element.scrollTop
    })
    expect(bottom).toBeGreaterThan(0)
    const statusFile = join(asyncRoot, runId, "status.json")
    const durableStatus = JSON.parse(readFileSync(statusFile, "utf8")) as {
      lastUpdate: number
    }
    durableStatus.lastUpdate += 1_000
    writeFileSync(statusFile, JSON.stringify(durableStatus))
    await window.evaluate(() => window.dispatchEvent(new Event("focus")))
    await expect.poll(
      () => transcriptScroll.evaluate((element) => element.scrollTop)
    ).toBeGreaterThan(0)

    rmSync(join(asyncRoot, ".active-runs", runId), { force: true })
    await window.evaluate(() => window.dispatchEvent(new Event("focus")))
    await expect(fleet).toHaveCount(0, { timeout: 15_000 })
  } finally {
    rmSync(join(asyncRoot, ".active-runs", runId), { force: true })
    rmSync(join(asyncRoot, runId), { recursive: true, force: true })
    rmSync(home, { recursive: true, force: true })
    rmSync(reposDir, { recursive: true, force: true })
    await auth.close()
  }
})
