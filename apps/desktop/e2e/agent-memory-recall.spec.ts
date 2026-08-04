import type { SeedSession } from "./fixtures.js"
import { appShell, expect, test } from "./fixtures.js"
import { type FakeMemoryRequest, startFakeAuthServer } from "./fake-auth.js"

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

const seededSession = (
  cli: "claude" | "codex",
  repoPath: string
): ReadonlyArray<SeedSession> => [
  {
    id: `s_automatic_memory_${cli}`,
    repo: "widget",
    branch: `jingler/automatic-memory-${cli}`,
    title: `Automatic memory ${cli}`,
    status: "idle",
    cli,
    diff: { added: 0, removed: 0 },
    prNumber: null,
    costUsd: 0,
    tokens: 0,
    updatedAt: "2026-08-04T10:00:00.000Z",
    worktreePath: repoPath,
    mode: "auto"
  }
]

for (const cli of ["claude", "codex"] as const) {
  test(`${cli} receives and captures accepted memory for an eligible turn`, async ({
    launchApp
  }) => {
    const fake = await startFakeAuthServer()
    try {
      const app = await launchApp({
        authServer: fake,
        configured: true,
        withRepo: true,
        sessions: ({ repoPath }) => seededSession(cli, repoPath),
        config: { memory: { enabled: true, organizationId: "org-e2e" } }
      })

      await expect(appShell(app.window)).toBeVisible()
      const composer = app.window.getByPlaceholder(
        cli === "claude" ? "Message Claude…" : "Message Codex…"
      )
      await composer.fill("alpha")
      await composer.press("Enter")
      await expect(app.window.getByText("1 passed", { exact: true })).toBeVisible({
        timeout: 30_000
      })

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
      await expect
        .poll(() => fake.memorySnapshot("org-e2e").sourceCount, { timeout: 30_000 })
        .toBe(1)

      await app.app.close()
    } finally {
      await fake.close()
    }
  })
}
