import type { SeedSession } from "./fixtures.js"
import { appShell, expect, test } from "./fixtures.js"
import { startFakeAuthServer } from "./fake-auth.js"

const USER_TASK = "Investigate why concurrent refund retries bypass the cap and report the verified fix."
const AGENT_REPLY =
  "The refund retry limiter now shares one route token bucket, so concurrent attempts cannot burst past the cap. The 429 verification passed."
const EXPLICIT_MEMORY_REQUEST = /\b(?:memory|remember|persist|save)\b/
const MEMORY_NARRATION = [
  "searching team memory",
  "checking team memory",
  "saving this to memory",
  "I will remember this"
] as const

const seededSession = (repoPath: string): ReadonlyArray<SeedSession> => [
  {
    id: "s_agent_memory_creation",
    repo: "widget",
    branch: "chore/agent-memory-creation",
    title: "Agent memory creation",
    status: "idle",
    cli: "claude",
    diff: { added: 0, removed: 0 },
    prNumber: null,
    costUsd: 0,
    tokens: 0,
    updatedAt: "2026-08-06T12:00:00.000Z",
    worktreePath: repoPath,
    mode: "auto"
  }
]

test("a non-trivial turn silently proposes durable learning and polls it to settlement", async ({
  launchApp
}) => {
  expect(USER_TASK.toLocaleLowerCase()).not.toMatch(EXPLICIT_MEMORY_REQUEST)
  const fake = await startFakeAuthServer()
  try {
    const app = await launchApp({
      authServer: fake,
      configured: true,
      withRepo: true,
      sessions: ({ repoPath }) => seededSession(repoPath),
      config: { memory: { enabled: true, organizationId: "org-e2e" } }
    })

    await expect(appShell(app.window)).toBeVisible()
    const composer = app.window.getByPlaceholder("Message Claude…")
    await composer.fill(USER_TASK)
    await composer.press("Enter")

    await expect(app.window.getByText(AGENT_REPLY, { exact: true })).toBeVisible({
      timeout: 30_000
    })
    await expect
      .poll(() => fake.memorySnapshot("org-e2e").acceptedPageIds, { timeout: 30_000 })
      .toContain("refund-retry-limiter")

    const creationCalls = fake.memoryRequests
      .filter((request) => request.rpcMethod === "tools/call")
      .map((request) => request.toolName)
      .filter((name): name is string => name !== null)
    const proposalIndex = creationCalls.indexOf("memory_propose")
    const searchIndex = creationCalls.lastIndexOf("memory_search", proposalIndex)
    const readIndex = creationCalls.lastIndexOf("memory_read", proposalIndex)
    const workflowCalls = creationCalls.filter((name) => name === "memory_workflow_status")

    expect(searchIndex).toBeGreaterThanOrEqual(0)
    expect(readIndex).toBeGreaterThan(searchIndex)
    expect(proposalIndex).toBeGreaterThan(readIndex)
    expect(workflowCalls).toHaveLength(2)
    expect(creationCalls.lastIndexOf("memory_workflow_status")).toBeGreaterThan(proposalIndex)

    await Promise.all(
      MEMORY_NARRATION.map((narration) =>
        expect(app.window.getByText(narration, { exact: false })).toHaveCount(0)
      )
    )

    await app.app.close()
  } finally {
    await fake.close()
  }
})
