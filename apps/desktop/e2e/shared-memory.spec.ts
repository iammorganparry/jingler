import type { SeedSession } from "./fixtures.js"
import { appShell, expect, test } from "./fixtures.js"
import { startFakeAuthServer } from "./fake-auth.js"

const REVIEWS = /^Reviews/
const CAPTURED_PROPOSAL = /proposal:captured-learning/
const STALE_PROPOSAL = /proposal:stale/
const SECRET_PROPOSAL = /proposal:secret/

const seededSession = ({ repoPath }: { repoPath: string }): ReadonlyArray<SeedSession> => [
  {
    id: "s_memory_author",
    repo: "widget",
    branch: "jingler/shared-memory",
    title: "Capture shared learning",
    status: "idle",
    cli: "claude",
    diff: { added: 0, removed: 0 },
    prNumber: null,
    costUsd: 0,
    tokens: 0,
    updatedAt: "2026-08-01T10:00:00.000Z",
    worktreePath: repoPath,
    mode: "auto"
  }
]

test("accepted session learning reaches a teammate but never another organization", async ({ launchApp }) => {
  const fake = await startFakeAuthServer()
  try {
    const author = await launchApp({
      authServer: fake,
      configured: true,
      withRepo: true,
      sessions: seededSession,
      config: { memory: { enabled: true, organizationId: "org-e2e" } }
    })
    await expect(appShell(author.window)).toBeVisible()

    const composer = author.window.getByPlaceholder("Message Claude…")
    await composer.fill("Capture the reusable refund limiter approach for the team.")
    await composer.press("Enter")

    // The settled turn creates one redacted source and a pending proposal. It is
    // not searchable until a reviewer accepts the multi-page publication.
    await expect.poll(() => fake.memorySnapshot("org-e2e").sourceCount, { timeout: 30_000 }).toBe(1)
    await author.window.getByTestId("memory-sidebar-item").click()
    const search = author.window.getByPlaceholder("Search memory")
    await search.fill("refund rate limiting")
    await expect(author.window.getByText("No accepted pages matched.")).toBeVisible()

    await author.window.getByRole("button", { name: REVIEWS }).click()
    const captured = author.window.getByRole("button", { name: CAPTURED_PROPOSAL })
    await expect(captured).toBeVisible()
    await captured.click()
    await expect(author.window.getByRole("tab")).toHaveCount(2)
    await author.window.getByRole("button", { name: "Accept all" }).click()
    await expect.poll(
      () => fake.memorySnapshot("org-e2e").proposalStatuses["proposal:captured-learning"]
    ).toBe("accepted")
    expect(fake.memorySnapshot("org-e2e").acceptedPageIds).toEqual(
      expect.arrayContaining(["shared-learning", "shared-checklist"])
    )

    // Agent attachment discovered the server independently; UI reads are
    // separate POSTs that can land on either simulated Next.js instance.
    const mcpTraffic = fake.memoryRequests.filter((request) => request.path === "/api/mcp")
    expect(mcpTraffic.some((request) => request.rpcMethod === "server/discover")).toBe(true)
    expect(mcpTraffic.some((request) => request.rpcMethod === "tools/call")).toBe(true)
    expect(new Set(mcpTraffic.map((request) => request.assignedInstance))).toEqual(
      new Set(["next-a", "next-b"])
    )
    for (const request of mcpTraffic) {
      expect(request.httpMethod).toBe("POST")
      // Gateway-originated calls carry the optional routing header; direct
      // stateless UI calls intentionally omit it. When present it must agree
      // with the JSON-RPC method.
      if (request.mcpMethod !== null) {
        expect(request.mcpMethod).toBe(request.rpcMethod)
        expect(request.metadataProtocolVersion).toBe("2026-07-28")
      }
      expect(request.protocolVersion).toBe("2026-07-28")
      expect(request.rpcMethod).not.toBe("initialize")
      expect(request.hasCookie).toBe(false)
      expect(request.hasSessionId).toBe(false)
    }

    await author.app.close()

    const teammate = await launchApp({
      authServer: fake,
      configured: true,
      config: { memory: { enabled: true, organizationId: "org-e2e" } }
    })
    await teammate.window.getByTestId("memory-sidebar-item").click()
    await teammate.window.getByPlaceholder("Search memory").fill("refund rate limiting")
    await expect(teammate.window.getByText("Refund rate limiting", { exact: true })).toBeVisible()
    await teammate.window.getByRole("button", { name: "Map" }).click()
    await expect(teammate.window.getByTestId("memory-node-page:shared-learning")).toBeVisible()
    await teammate.app.close()

    const outsider = await launchApp({
      authServer: fake,
      configured: true,
      config: { memory: { enabled: true, organizationId: "org-other" } }
    })
    await outsider.window.getByTestId("memory-sidebar-item").click()
    await outsider.window.getByPlaceholder("Search memory").fill("refund rate limiting")
    await expect(outsider.window.getByText("No accepted pages matched.")).toBeVisible()
    await outsider.window.getByRole("button", { name: "Map" }).click()
    await expect(outsider.window.getByTestId("memory-node-page:shared-learning")).toHaveCount(0)
    expect(fake.memorySnapshot("org-other").acceptedPageIds).not.toContain("shared-learning")
  } finally {
    await fake.close()
  }
})

test("review lint conflicts, paid-team enforcement, and memory outage all fail safely", async ({ launchApp }) => {
  const fake = await startFakeAuthServer()
  try {
    const reviewer = await launchApp({
      authServer: fake,
      configured: true,
      config: { memory: { enabled: true, organizationId: "org-e2e" } }
    })
    await reviewer.window.getByTestId("memory-sidebar-item").click()
    await reviewer.window.getByRole("button", { name: REVIEWS }).click()

    await reviewer.window.getByRole("button", { name: STALE_PROPOSAL }).click()
    await reviewer.window.getByRole("button", { name: "Accept all" }).click()
    const staleConflict = reviewer.window.getByRole("alert")
    await expect(staleConflict).toContainText("Publication conflict")
    await expect(staleConflict).toContainText("revision:alpha:2")

    await reviewer.window.getByRole("button", { name: SECRET_PROPOSAL }).click()
    await reviewer.window.getByRole("button", { name: "Accept all" }).click()
    const secretConflict = reviewer.window.getByRole("alert")
    await expect(secretConflict).toContainText("credential-shaped-content")
    expect(fake.memorySnapshot("org-e2e").secretRejections).toBe(1)
    expect(fake.memorySnapshot("org-e2e").acceptedPageIds).not.toContain("secret-page")
    await reviewer.app.close()

    const freeMember = await launchApp({
      authServer: fake,
      configured: true,
      config: { memory: { enabled: true, organizationId: "org-free" } }
    })
    await expect(appShell(freeMember.window)).toBeVisible()
    await freeMember.window.getByTestId("memory-sidebar-item").click()
    await expect(freeMember.window.getByText("Choose a team memory vault")).toBeVisible()
    await expect(
      freeMember.window.getByRole("combobox", { name: "Memory organization" })
        .locator('option[value="org-free"]')
    ).toHaveCount(0)
    await freeMember.app.close()

    fake.setMemoryAvailable(false)
    const offline = await launchApp({
      authServer: fake,
      configured: true,
      withRepo: true,
      sessions: seededSession,
      config: { memory: { enabled: true, organizationId: "org-e2e" } }
    })
    await expect(appShell(offline.window)).toBeVisible()
    await expect(offline.window.getByTestId("memory-sidebar-item")).toHaveCount(0)
    const composer = offline.window.getByPlaceholder("Message Claude…")
    await composer.fill("Keep working even though team memory is unavailable.")
    await composer.press("Enter")
    await expect(offline.window.getByText("1 passed", { exact: true })).toBeVisible({ timeout: 30_000 })
    await expect(offline.window.getByTestId("session-row-s_memory_author").getByText("Idle", { exact: true })).toBeVisible({ timeout: 30_000 })
  } finally {
    await fake.close()
  }
})
