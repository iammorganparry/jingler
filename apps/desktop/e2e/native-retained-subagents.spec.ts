import { readFile, readdir } from "node:fs/promises"
import { join, resolve } from "node:path"
import type { Page } from "@playwright/test"
import { appShell, expect, test, type LaunchedApp, type LaunchOptions, type SeedSession } from "./fixtures.js"

const claudeBinary = resolve(import.meta.dirname, "../../../packages/cli-adapters/src/runtime/agent/fixtures/claude-subagent.mjs")
const codexBinary = resolve(import.meta.dirname, "../../../packages/cli-adapters/src/runtime/codex/fixtures/app-server.mjs")
const opencodeBinary = resolve(import.meta.dirname, "../../../packages/cli-adapters/src/runtime/opencode/fixtures/server.mjs")
const worker = resolve(import.meta.dirname, "fake-subagent-process-worker.mjs")
const launchPrompt = "Launch the retained native workflow"
const modelButton = /^Model:/
const activeWorker = /worker ·/
const previousWorker = /Open .*worker/
const terminalJobState = /failed|stopped/
const stopText = /stop/i
const stoppedText = /stopped|no longer active/i

type RuntimeCase = {
  readonly runtime: "Claude" | "Codex" | "OpenCode"
  readonly option: RegExp
  readonly env: Readonly<Record<string, string>>
  readonly authRoute: "api-key" | "openai-codex-oauth"
  readonly parentSettled: string
  readonly secondPrompt: string
  readonly secondSettled: string
}

const cases: ReadonlyArray<RuntimeCase> = [
  {
    runtime: "Claude",
    option: /^Haiku \(latest\)/,
    env: { JINGLER_CLAUDE_BINARY: claudeBinary, JINGLER_SUBAGENT_PROCESS_WORKER: worker },
    authRoute: "openai-codex-oauth",
    parentSettled: "Native Claude parent settled after detached launch.",
    secondPrompt: "Second retained Claude parent turn",
    secondSettled: "PI child completed without a configured PI provider."
  },
  {
    runtime: "Codex",
    option: /^First/,
    env: {
      JINGLER_CODEX_BINARY: codexBinary,
      JINGLER_SUBAGENT_PROCESS_WORKER: worker,
      CODEX_HOME: "unique-threads"
    },
    authRoute: "openai-codex-oauth",
    parentSettled: "Native Codex parent settled after detached launch.",
    secondPrompt: "Second retained Codex parent turn",
    secondSettled: "Native Codex second parent turn completed."
  },
  {
    runtime: "OpenCode",
    option: /^OpenCode beta/,
    env: { JINGLER_OPENCODE_BINARY: opencodeBinary, JINGLER_SUBAGENT_PROCESS_WORKER: worker },
    authRoute: "api-key",
    parentSettled: "Native OpenCode parent settled after detached launch.",
    secondPrompt: "Second retained OpenCode parent turn",
    secondSettled: "Native OpenCode second parent turn completed."
  }
]

const sessions = ({ repoPath }: { readonly repoPath: string }): ReadonlyArray<SeedSession> => [{
  id: "s_native_retained",
  repo: "widget",
  repoPath,
  worktreePath: repoPath,
  workspaceMode: "direct",
  branch: "main",
  title: "Native retained workflow",
  status: "idle",
  diff: { added: 0, removed: 0 },
  prNumber: null,
  costUsd: 0,
  tokens: 0,
  updatedAt: "2026-10-01T00:00:00.000Z"
}]

const launchOptions = (entry: RuntimeCase): LaunchOptions => ({
  configured: true,
  withRepo: true,
  sessions,
  piFixture: { scenarioId: "composer-capabilities", authRoute: entry.authRoute },
  e2eEnv: entry.env
})

const send = async (window: Page, prompt: string) => {
  const composer = window.getByPlaceholder("Message the agent…")
  await composer.fill(prompt)
  await composer.press("Enter")
}

const selectRuntime = async (window: Page, entry: RuntimeCase) => {
  await window.getByRole("button", { name: modelButton }).click()
  await window.getByRole("option", { name: entry.option }).click()
}

const activeChild = (window: Page) =>
  window.getByRole("button", { name: activeWorker }).first()

const openPreviousChild = async (window: Page) => {
  await window.getByRole("button", { name: "Previous subagents" }).click()
  const previous = window.getByRole("menuitem", { name: previousWorker }).first()
  await expect(previous).toBeVisible({ timeout: 30_000 })
  await previous.click()
}

const stopDetachedChild = async (window: Page) => {
  const child = activeChild(window)
  await expect(child).toBeVisible({ timeout: 30_000 })
  await child.click()
  const transcript = window.getByTestId("fleet-agent-transcript")
  await expect(transcript).toBeVisible()
  await expect(transcript.getByTestId("fleet-agent-live")).toContainText("Working…")
  await window.getByRole("button", { name: "Stop" }).click()
  await expect(window.getByTestId("subagent-control-outcome")).toContainText(stopText, { timeout: 30_000 })
  await openPreviousChild(window)
  await expect(window.getByTestId("fleet-agent-transcript")).toContainText(stoppedText, { timeout: 30_000 })
}

const launchWorkflow = async (
  launchApp: (options?: LaunchOptions) => Promise<LaunchedApp>,
  entry: RuntimeCase
) => {
  const launched = await launchApp(launchOptions(entry))
  await expect(appShell(launched.window)).toBeVisible()
  await selectRuntime(launched.window, entry)
  await send(launched.window, launchPrompt)
  await expect(launched.window.getByText(entry.parentSettled, { exact: true }))
    .toBeVisible({ timeout: 45_000 })
  await expect(activeChild(launched.window)).toBeVisible({ timeout: 30_000 })
  await send(launched.window, entry.secondPrompt)
  await expect(launched.window.getByText(entry.secondSettled, { exact: true }))
    .toBeVisible({ timeout: 45_000 })
  return launched
}

for (const entry of cases) {
  test(`native ${entry.runtime} retains a detached child after the parent settles`, async ({ launchApp }) => {
    test.setTimeout(180_000)
    const launched = await launchWorkflow(launchApp, entry)
    await stopDetachedChild(launched.window)
  })
}

test("restores terminal native job state after a cold app restart", async ({ launchApp }) => {
  test.setTimeout(240_000)
  const entry = cases[1]!
  const first = await launchWorkflow(launchApp, entry)
  const jobsDir = join(first.home, "jingler", "runtime", "journals", "native-external-jobs")
  await expect.poll(async () =>
    (await readdir(jobsDir)).filter((name) => name.endsWith(".json")).length,
  { timeout: 45_000 }).toBe(1)
  const recordsBefore = (await readdir(jobsDir)).filter((name) => name.endsWith(".json"))
  await first.app.close()

  const restarted = await launchApp({
    configured: true,
    withRepo: true,
    home: first.home,
    reposDir: first.reposDir,
    userDataDir: first.userDataDir,
    authServer: first.authServer,
    githubServer: first.githubServer,
    githubRelay: first.githubRelay,
    piFixture: { scenarioId: "composer-capabilities", authRoute: entry.authRoute },
    e2eEnv: entry.env
  })
  await expect(appShell(restarted.window)).toBeVisible()
  const recordPath = join(jobsDir, recordsBefore[0]!)
  await expect.poll(async () => JSON.parse(await readFile(recordPath, "utf8")).state, {
    timeout: 45_000
  }).toMatch(terminalJobState)
  expect((await readdir(jobsDir)).filter((name) => name.endsWith(".json")))
    .toEqual(recordsBefore)
})
