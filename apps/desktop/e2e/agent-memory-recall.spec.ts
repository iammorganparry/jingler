import type { LaunchedApp, SeedSession } from "./fixtures.js"
import { appShell, expect, test } from "./fixtures.js"
import { type FakeMemoryRequest, startFakeAuthServer } from "./fake-auth.js"

const COMPLETED_PI_REPLY = /^Completed through deterministic pi\./u
const FAILED_MEMORY_MCP = /jingler-memory: failed/u

const memoryRequestCount = (
  requests: ReadonlyArray<FakeMemoryRequest>,
  name: "memory_search" | "memory_read"
): number => requests.filter((request) => request.mcpName === name).length

const recalledRequests = (
  requests: ReadonlyArray<FakeMemoryRequest>
): ReadonlyArray<FakeMemoryRequest> =>
  requests.filter(
    (request) => request.mcpName === "memory_search" || request.mcpName === "memory_read"
  )

const sourceIngestRequests = (
  requests: ReadonlyArray<FakeMemoryRequest>
): ReadonlyArray<FakeMemoryRequest> =>
  requests.filter(
    (request) => request.path === "/api/memory/sources" && request.httpMethod === "POST"
  )

const expectLifecycleTraffic = (requests: ReadonlyArray<FakeMemoryRequest>): void => {
  const calls = requests.filter((request) => request.rpcMethod === "tools/call")
  expect(calls.some(
    (request) =>
      request.mcpName === "memory_search" &&
      String(request.toolArguments?.query).includes("Project: widget")
  )).toBe(true)
  expect(calls.some(
    (request) =>
      request.mcpName === "memory_search" &&
      request.toolArguments?.query === "Tool: command_execute:printf"
  )).toBe(true)
  expect(calls.some(
    (request) =>
      request.mcpName === "memory_read" &&
      request.toolArguments?.pageId === "command-printf"
  )).toBe(true)
  expect(calls.find((request) => request.toolName === "memory_propose")?.toolArguments)
    .toMatchObject({ pageId: "pi-command-learning", baseRevisionId: "new" })
  expect(calls.some(
    (request) =>
      request.toolName === "memory_workflow_status" &&
      typeof request.toolArguments?.workflowId === "string"
  )).toBe(true)
}

const runRecallTurn = async (app: LaunchedApp): Promise<void> => {
  const composer = app.window.getByPlaceholder("Message the agent…")
  await composer.fill("How should reusable printf templates handle percent signs?")
  await composer.press("Enter")
  await expect(app.window.getByText(COMPLETED_PI_REPLY)).toBeVisible({ timeout: 30_000 })
}

const seededSession = (repoPath: string): ReadonlyArray<SeedSession> => [
  {
    id: "s_automatic_memory",
    repo: "widget",
    branch: "chore/automatic-memory",
    title: "Automatic memory",
    status: "idle",
    diff: { added: 0, removed: 0 },
    prNumber: null,
    costUsd: 0,
    tokens: 0,
    updatedAt: "2026-08-04T10:00:00.000Z",
    worktreePath: repoPath,
    mode: "auto"
  }
]

test("pi recalls, applies a tool advisory, publishes, and shares a learning within one organization", async ({ launchApp }) => {
  const fake = await startFakeAuthServer({ reviewProposals: false, toolMemoryPage: true })
  try {
    const author = await launchApp({
      authServer: fake,
      configured: true,
      withRepo: true,
      piFixture: { scenarioId: "memory-lifecycle", authRoute: "api-key" },
      sessions: ({ repoPath }) => seededSession(repoPath),
      config: { memory: { enabled: true, organizationId: "org-e2e" } }
    })
    const composer = author.window.getByPlaceholder("Message the agent…")
    await composer.fill("Use the accepted alpha architecture while checking a reusable printf command.")
    await composer.press("Enter")
    await expect(
      author.window.getByText("PI memory lifecycle completed with a cited tool advisory.")
    ).toBeVisible({ timeout: 30_000 })
    await expect.poll(() => fake.memorySnapshot("org-e2e").acceptedPageIds, { timeout: 30_000 })
      .toContain("pi-command-learning")

    expectLifecycleTraffic(fake.memoryRequests)
    await author.app.close()

    const teammateRequestStart = fake.memoryRequests.length
    const teammate = await launchApp({
      authServer: fake,
      configured: true,
      withRepo: true,
      piFixture: { scenarioId: "default", authRoute: "api-key" },
      sessions: ({ repoPath }) => seededSession(repoPath),
      config: { memory: { enabled: true, organizationId: "org-e2e" } }
    })
    await runRecallTurn(teammate)
    expect(fake.memoryRequests.slice(teammateRequestStart).some(
      (request) =>
        request.mcpName === "memory_read" &&
        request.toolArguments?.pageId === "pi-command-learning" &&
        request.organizationId === "org-e2e"
    )).toBe(true)
    await teammate.app.close()

    const outsiderRequestStart = fake.memoryRequests.length
    const outsider = await launchApp({
      authServer: fake,
      configured: true,
      withRepo: true,
      piFixture: { scenarioId: "default", authRoute: "api-key" },
      sessions: ({ repoPath }) => seededSession(repoPath),
      config: { memory: { enabled: true, organizationId: "org-other" } }
    })
    await runRecallTurn(outsider)
    expect(fake.memoryRequests.slice(outsiderRequestStart).some(
      (request) => request.toolArguments?.pageId === "pi-command-learning"
    )).toBe(false)
  } finally {
    await fake.close()
  }
})

test("pi receives accepted memory without raw settled-turn capture", async ({ launchApp }) => {
  const fake = await startFakeAuthServer()
  try {
    const app = await launchApp({
      authServer: fake,
      configured: true,
      withRepo: true,
      piFixture: { scenarioId: "memory-recall", authRoute: "api-key" },
      sessions: ({ repoPath }) => seededSession(repoPath),
      config: { memory: { enabled: true, organizationId: "org-e2e" } }
    })

    await expect(appShell(app.window)).toBeVisible()
    const composer = app.window.getByPlaceholder("Message the agent…")
    await composer.fill("alpha")
    await composer.press("Enter")
    await expect(app.window.getByText("Completed through deterministic pi.")).toBeVisible({
      timeout: 30_000
    })
    await expect(
      app.window
        .getByTestId("session-row-s_automatic_memory")
        .getByText("Idle", { exact: true })
    ).toBeVisible({ timeout: 30_000 })

    await expect
      .poll(() => memoryRequestCount(fake.memoryRequests, "memory_search"))
      .toBe(1)
    await expect
      .poll(() => memoryRequestCount(fake.memoryRequests, "memory_read"))
      .toBeGreaterThan(0)

    const recall = recalledRequests(fake.memoryRequests)
    expect(recall[0]?.mcpName).toBe("memory_search")
    expect(recall.some((request) => request.mcpName === "memory_read")).toBe(true)
    expect(recall.every((request) => request.hasCookie === false)).toBe(true)
    expect(recall.every((request) => request.hasSessionId === false)).toBe(true)
    expect(fake.memoryRequests.some(
      (request) =>
        request.rpcMethod === "tools/call" &&
        request.mcpMethod === null &&
        request.mcpName === null
    )).toBe(true)
    expect(sourceIngestRequests(fake.memoryRequests)).toEqual([])

    await app.app.close()
  } finally {
    await fake.close()
  }
})

test("an unavailable memory MCP does not abort Jingler's real pi tools", async ({
  launchApp
}) => {
  const fake = await startFakeAuthServer()
  try {
    const app = await launchApp({
      authServer: fake,
      configured: true,
      withRepo: true,
      piFixture: { scenarioId: "memory-mcp-isolation", authRoute: "api-key" },
      sessions: ({ repoPath }) => seededSession(repoPath),
      config: { memory: { enabled: true, organizationId: "org-e2e" } }
    })
    const completed = app.window.getByText(COMPLETED_PI_REPLY)
    const composer = app.window.getByPlaceholder("Message the agent…")

    await composer.fill("Warm the managed memory attachment.")
    await composer.press("Enter")
    await expect(completed).toHaveCount(1, { timeout: 30_000 })

    fake.setMemoryAvailable(false)
    await composer.fill("Continue with Jingler's available tools.")
    await composer.press("Enter")
    await expect(completed).toHaveCount(2, { timeout: 30_000 })

    await app.window.getByRole("button", { name: "Account menu" }).click()
    await app.window.getByRole("menuitem", { name: "Settings" }).click()
    await app.window.getByRole("button", { name: "Runtime" }).click()
    await expect(
      app.window
        .getByRole("region", { name: "Runtime inspector" })
        .getByText(FAILED_MEMORY_MCP)
    ).toBeVisible()
  } finally {
    await fake.close()
  }
})
