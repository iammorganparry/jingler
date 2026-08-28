import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { appShell, expect, type SeedSession, test } from "./fixtures.js"

const CONNECTION_ID = "jingler-e2e-connection"
const PROVIDER_ID = "jingler-e2e"
const MODEL_ID = "jingler-e2e/eval-model"
const MODEL_LABEL = "Deterministic pi model"
const PI_FIXTURE = {
  scenarioId: "composer-capabilities",
  authRoute: "api-key" as const,
  reasoning: ["low", "medium", "high", "xhigh"] as const
}

const sessions = (id: string): ((input: { repoPath: string }) => ReadonlyArray<SeedSession>) =>
  ({ repoPath }) => [{
    id,
    repo: "widget",
    repoPath,
    branch: "main",
    title: "Capability workspace",
    status: "idle",
    connectionId: CONNECTION_ID,
    providerId: PROVIDER_ID,
    modelId: MODEL_ID,
    diff: { added: 0, removed: 0 },
    prNumber: null,
    costUsd: 0,
    tokens: 0,
    updatedAt: "2026-08-11T00:00:00.000Z",
    worktreePath: repoPath,
    workspaceMode: "direct",
    chats: [{
      id: `${id}_chat`,
      title: null,
      createdAt: "2026-08-11T00:00:00.000Z",
      updatedAt: "2026-08-11T00:00:00.000Z",
      mode: "accept-edits",
      connectionId: CONNECTION_ID,
      providerId: PROVIDER_ID,
      modelId: MODEL_ID
    }],
    activeChatId: `${id}_chat`
  }]

test("offers only certified connection models, never harness choices", async ({ launchApp }) => {
  const launched = await launchApp({
    configured: true,
    withRepo: true,
    piFixture: PI_FIXTURE,
    sessions: sessions("s_certified_models")
  })
  await expect(appShell(launched.window)).toBeVisible()

  await launched.window.getByRole("button", { name: `Model: ${MODEL_LABEL}` }).click()
  const modelOption = launched.window.getByRole("option", { name: new RegExp(`^${MODEL_LABEL}`) })
  await expect(modelOption).toBeVisible()
  await expect(modelOption).toHaveAttribute(
    "data-value",
    `${CONNECTION_ID}:${encodeURIComponent(MODEL_ID)}`
  )
  await expect(launched.window.getByText(/Claude Code|Codex CLI|OpenCode|Cursor Agent/i)).toHaveCount(0)
})

test("offers the same Jingler permission modes for every certified model", async ({ launchApp }) => {
  const launched = await launchApp({
    configured: true,
    withRepo: true,
    piFixture: PI_FIXTURE,
    sessions: sessions("s_provider_modes")
  })
  await expect(appShell(launched.window)).toBeVisible()

  await launched.window.getByRole("button", { name: "Accept Edits", exact: true }).click()
  await expect(launched.window.getByRole("option", { name: /^Ask Before Actions\b/ })).toBeVisible()
  await expect(launched.window.getByRole("option", { name: /^Accept Edits\b/ })).toBeVisible()
  await expect(launched.window.getByRole("option", { name: /^Auto\b/ })).toBeVisible()
  await expect(launched.window.getByRole("option", { name: /^Plan\b/ })).toBeVisible()
})

test("derives reasoning choices from the certified model capability", async ({ launchApp }) => {
  const launched = await launchApp({
    configured: true,
    withRepo: true,
    piFixture: PI_FIXTURE,
    sessions: sessions("s_reasoning_models")
  })
  await expect(appShell(launched.window)).toBeVisible()

  await launched.window.getByRole("button", { name: "Thinking strength" }).click()
  for (const label of ["Off", "Low", "Medium", "High", "Xhigh"]) {
    await expect(launched.window.getByRole("option", { name: label, exact: true })).toBeVisible()
  }
})

test("persists mode and chat reasoning across restart", async ({ launchApp }) => {
  const first = await launchApp({
    configured: true,
    withRepo: true,
    piFixture: PI_FIXTURE,
    sessions: sessions("s_capability_restart")
  })
  await expect(appShell(first.window)).toBeVisible()
  await first.window.getByRole("button", { name: "Accept Edits", exact: true }).click()
  await first.window.getByRole("option", { name: /^Auto\b/ }).click()
  await first.window.getByRole("button", { name: "Thinking strength" }).click()
  await first.window.getByRole("option", { name: "High", exact: true }).click()

  await expect.poll(() => {
    const persisted = JSON.parse(readFileSync(join(first.home, "jingler", "sessions.json"), "utf8"))[0]
    return {
      connectionId: persisted.chats[0].connectionId,
      modelId: persisted.chats[0].modelId,
      mode: persisted.chats[0].mode,
      reasoning: persisted.chats[0].reasoning
    }
  }).toEqual({
    connectionId: CONNECTION_ID,
    modelId: MODEL_ID,
    mode: "auto",
    reasoning: { enabled: true, effort: "high" }
  })
  await first.app.close()

  const reopened = await launchApp({
    home: first.home,
    reposDir: first.reposDir,
    userDataDir: first.userDataDir,
    configured: true,
    withRepo: true,
    piFixture: PI_FIXTURE
  })
  await expect(appShell(reopened.window)).toBeVisible()
  await expect(reopened.window.getByRole("button", { name: `Model: ${MODEL_LABEL}` })).toBeVisible()
  await expect(reopened.window.getByRole("button", { name: "Auto" })).toBeVisible()
  await expect(reopened.window.getByRole("button", { name: "Thinking strength" })).toContainText("High")
})

test("configures canonical model, mode, and reasoning before creating a session", async ({ launchApp }) => {
  const launched = await launchApp({
    configured: true,
    withRepo: true,
    piFixture: PI_FIXTURE
  })
  await expect(appShell(launched.window)).toBeVisible()
  await launched.window.getByTestId("new-session").click()

  const selectorWidths = await Promise.all(
    [
      launched.window.getByRole("button", { name: "Project", exact: true }),
      launched.window.getByRole("button", { name: "Checkout", exact: true }),
      launched.window.getByRole("button", { name: "Base branch", exact: true })
    ].map(async (selector) => (await selector.boundingBox())?.width)
  )
  const [projectWidth, ...otherWidths] = selectorWidths
  expect(projectWidth).toBeGreaterThanOrEqual(210)
  expect(otherWidths).toEqual([projectWidth, projectWidth])

  await expect(
    launched.window.getByRole("button", { name: `Model: ${MODEL_LABEL}` })
  ).toBeVisible()
  await launched.window.getByRole("button", { name: "Auto", exact: true }).click()
  await launched.window.getByRole("option", { name: /^Ask Before Actions\b/ }).click()
  await launched.window.getByRole("button", { name: "Thinking strength" }).click()
  await launched.window.getByRole("option", { name: "High", exact: true }).click()
  await launched.window.getByRole("button", { name: "Checkout" }).click()
  await launched.window.getByRole("option", { name: "Local" }).click()
  await launched.window.getByRole("button", { name: "Create workspace" }).click()

  await expect.poll(() => {
    const sessionsPath = join(launched.home, "jingler", "sessions.json")
    if (!existsSync(sessionsPath)) return null
    const persisted = JSON.parse(readFileSync(sessionsPath, "utf8"))[0]
    return {
      connectionId: persisted?.chats?.[0]?.connectionId,
      providerId: persisted?.chats?.[0]?.providerId,
      modelId: persisted?.chats?.[0]?.modelId,
      mode: persisted?.chats?.[0]?.mode,
      reasoning: persisted?.chats?.[0]?.reasoning
    }
  }).toEqual({
    connectionId: CONNECTION_ID,
    providerId: PROVIDER_ID,
    modelId: MODEL_ID,
    mode: "ask",
    reasoning: { enabled: true, effort: "high" }
  })
})
