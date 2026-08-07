import type { SeedSession } from "./fixtures.js"
import { appShell, expect, test } from "./fixtures.js"
import { startFakeAuthServer } from "./fake-auth.js"

const REVIEWS = /^Reviews/
const COMPILER_WORKFLOW = /^compiler-[0-9a-f]{64}$/

const seededSession = ({ repoPath }: { repoPath: string }): ReadonlyArray<SeedSession> => [
  {
    id: "s_memory_author",
    repo: "widget",
    branch: "chore/shared-memory",
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
  const fake = await startFakeAuthServer({ reviewProposals: false })
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
    await composer.fill("[[memory-propose]] Capture the reusable refund limiter approach for the team.")
    await composer.press("Enter")

    // The agent deliberately proposes the durable fact through its attached MCP
    // tool. Publication is automatic: no human review queue is involved.
    await expect.poll(() => fake.memorySnapshot("org-e2e").sourceCount, { timeout: 30_000 }).toBe(1)
    await expect.poll(
      () => fake.memorySnapshot("org-e2e").acceptedPageIds
    ).toEqual(expect.arrayContaining(["shared-learning"]))
    await author.window.getByTestId("memory-sidebar-item").click()
    await expect(author.window.getByRole("button", { name: REVIEWS })).toHaveCount(0)
    const search = author.window.getByPlaceholder("Search memory")
    // This phrase exists only in the submitted Markdown, so finding the page
    // proves the fake compiled the tool payload instead of returning a fixture.
    await search.fill("bursts cannot multiply")
    await expect(author.window.getByText("Refund rate limiting", { exact: true })).toBeVisible()

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
    const proposalRequest = mcpTraffic.find((request) => request.toolName === "memory_propose")
    expect(proposalRequest?.toolArguments).toEqual({
      pageId: "shared-learning",
      baseRevisionId: "new",
      markdown: "# Refund rate limiting\n\nRefund retries share one team limiter so bursts cannot multiply across workers."
    })
    const workflowRequest = mcpTraffic.find(
      (request) => request.toolName === "memory_workflow_status"
    )
    expect(workflowRequest?.toolArguments).toMatchObject({
      workflowId: expect.stringMatching(COMPILER_WORKFLOW)
    })

    await author.app.close()

    const teammate = await launchApp({
      authServer: fake,
      configured: true,
      config: { memory: { enabled: true, organizationId: "org-e2e" } }
    })
    await teammate.window.getByTestId("memory-sidebar-item").click()
    await teammate.window.getByPlaceholder("Search memory").fill("bursts cannot multiply")
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
    await outsider.window.getByPlaceholder("Search memory").fill("bursts cannot multiply")
    await expect(outsider.window.getByText("No accepted pages matched.")).toBeVisible()
    await outsider.window.getByRole("button", { name: "Map" }).click()
    await expect(outsider.window.getByTestId("memory-node-page:shared-learning")).toHaveCount(0)
    expect(fake.memorySnapshot("org-other").acceptedPageIds).not.toContain("shared-learning")
  } finally {
    await fake.close()
  }
})

test("a stale agent proposal surfaces its conflict without overwriting accepted memory", async ({ launchApp }) => {
  const fake = await startFakeAuthServer({ reviewProposals: false })
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
    await composer.fill("[[memory-propose-conflict]] Try to replace alpha from its stale revision.")
    await composer.press("Enter")

    await expect(author.window.getByText(
      "Memory proposal conflict for alpha: expected revision:alpha:1; current revision:alpha:2.",
      { exact: true }
    )).toBeVisible({ timeout: 30_000 })
    expect(fake.memorySnapshot("org-e2e").acceptedRevisions.alpha).toBe(2)
    expect(fake.memorySnapshot("org-e2e").sourceCount).toBe(0)

    const proposalRequest = fake.memoryRequests.find(
      (request) => request.toolName === "memory_propose"
    )
    expect(proposalRequest?.toolArguments).toEqual({
      pageId: "alpha",
      baseRevisionId: "revision:alpha:1",
      markdown: "# Alpha memory\n\nA stale update must never overwrite revision two."
    })
  } finally {
    await fake.close()
  }
})

test("historical proposals never surface a queue, and access failures remain safe", async ({ launchApp }) => {
  const fake = await startFakeAuthServer()
  try {
    const member = await launchApp({
      authServer: fake,
      configured: true,
      config: { memory: { enabled: true, organizationId: "org-e2e" } }
    })
    await member.window.getByTestId("memory-sidebar-item").click()
    await expect(member.window.getByRole("button", { name: REVIEWS })).toHaveCount(0)
    expect(fake.memorySnapshot("org-e2e").proposalStatuses).toMatchObject({
      "proposal:stale": "open",
      "proposal:secret": "open"
    })
    await member.app.close()

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
