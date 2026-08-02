import { Effect } from "effect"
import {
  serializeMemoryMarkdown,
  type MemoryPage,
  type MemorySource
} from "@jingler/memory"
import { describe, expect, it } from "vitest"
import { VAULT_ORGANIZATION_HEADER } from "../auth.js"
import { handleMemoryWorkerRequest, handleTeamVaultRequest } from "../api.js"
import type {
  DurableObjectIdLike,
  DurableObjectNamespaceLike,
  DurableObjectStubLike,
  MemoryWorkerEnv,
  WorkflowBindingLike,
  WorkflowInstanceLike,
  WorkflowInstanceStatusLike
} from "../env.js"
import { captureVaultDerivedFingerprints, reconcileVaultFromR2 } from "../reconciliation.js"
import { InMemoryR2Bucket, MemoryR2Store } from "../r2-store.js"
import { InMemoryVaultState, TeamVault } from "../team-vault.js"
import {
  runCompilerWorkflow,
  type CompilerContext,
  type CompilerGeneratedProposal,
  type CompilerModel,
  type CompilerRepository,
  type CompilerWorkflowInput,
  type WorkflowStepLike
} from "./compiler.js"

// Runs an Effect-returning vault/reconciliation call to a Promise at the test boundary.
const run = Effect.runPromise

const baseSource: MemorySource = {
  id: "source-base",
  kind: "manual",
  title: "Base evidence"
}

const compilerSource: MemorySource = {
  id: "source-session",
  kind: "conversation",
  title: "Settled session",
  retrievedAt: "2026-08-01T09:00:00.000Z"
}

const page = (id: "alpha" | "beta", revision = 1): MemoryPage => ({
  id,
  path: `${id}.md`,
  title: id === "alpha" ? "Alpha rollout" : "Beta runbook",
  revision,
  aliases: [],
  tags: [id],
  sources: [],
  citations: [{ id: `${id}-base`, sourceId: baseSource.id }],
  relationships: [],
  body: `# ${id}\n\nThe ${id} baseline is accepted. [@${id}-base]\n`,
  metadata: {}
})

const compiledPage = (
  accepted: MemoryPage,
  body: string,
  relationships: MemoryPage["relationships"] = []
): MemoryPage => ({
  ...accepted,
  revision: accepted.revision + 1,
  citations: [
    ...accepted.citations,
    { id: `${accepted.id}-session`, sourceId: compilerSource.id }
  ],
  relationships,
  body
})

class ImmediateStep implements WorkflowStepLike {
  readonly names: Array<string> = []

  async do<Result>(name: string, callback: () => Promise<Result> | Result): Promise<Result> {
    this.names.push(name)
    return callback()
  }
}

class AcceptedReviewStep extends ImmediateStep {
  constructor(private readonly approve: () => Promise<void>) {
    super()
  }

  async waitForEvent<Result>(
    _name: string,
    _options: { readonly type: string; readonly timeout: string }
  ): Promise<{ readonly payload: Result }> {
    await this.approve()
    return { payload: JSON.parse('{"status":"accepted"}') }
  }
}

class VaultCompilerRepository implements CompilerRepository {
  constructor(readonly vault: TeamVault) {}

  async readSource(sourceId: string) {
    return run(this.vault.readSource(sourceId))
  }

  async listAcceptedPages() {
    const heads = await run(this.vault.listPages())
    return Promise.all(
      heads.map(async (head) => {
        const accepted = await run(this.vault.readPage(head.pageId))
        return { page: accepted.page, revisionId: accepted.revision.id }
      })
    )
  }

  async readNavigation() {
    return run(this.vault.navigation())
  }

  createProposalSet(input: Parameters<TeamVault["createProposalSet"]>[0]) {
    return run(this.vault.createProposalSet(input))
  }

  async approveProposalSet(proposalSetId: string, reviewerId: string, acceptedAt: string) {
    const result = await run(this.vault.approveProposalSet(proposalSetId, reviewerId, acceptedAt))
    return { status: result.status }
  }
}

class FixtureModel implements CompilerModel {
  calls = 0

  async generate(context: CompilerContext): Promise<CompilerGeneratedProposal> {
    this.calls += 1
    const byId = new Map(context.candidates.map((candidate) => [candidate.page.id, candidate]))
    const alpha = byId.get("alpha")!
    const beta = byId.get("beta")!
    return {
      changeKind: "factual",
      drafts: [
        {
          pageId: alpha.page.id,
          baseRevisionId: alpha.revisionId,
          markdown: serializeMemoryMarkdown(
            compiledPage(
              alpha.page,
              "# Alpha rollout\n\nThe alpha rollout depends on [[Beta runbook]]. [@alpha-session]\n",
              [{ kind: "dependency", target: "beta" }]
            )
          )
        },
        {
          pageId: beta.page.id,
          baseRevisionId: beta.revisionId,
          markdown: serializeMemoryMarkdown(
            compiledPage(
              beta.page,
              "# Beta runbook\n\nThe beta canary uses a reversible rollout. [@beta-session]\n"
            )
          )
        }
      ]
    }
  }
}

const workflowInput: CompilerWorkflowInput = {
  workflowId: "compiler-fixture",
  organizationId: "org-compiler",
  sourceId: compilerSource.id,
  requestedBy: "agent-1",
  createdAt: "2026-08-01T10:00:00.000Z"
}

const seedVault = async (bucket = new InMemoryR2Bucket()): Promise<TeamVault> => {
  const vault = await run(TeamVault.create("org-compiler", new InMemoryVaultState(), bucket))
  await run(vault.ingestSource(baseSource, "Base evidence"))
  await run(vault.ingestSource(
    compilerSource,
    "Alpha rollout depends on the beta runbook. Beta canaries should use a reversible rollout."
  ))
  for (const accepted of [page("alpha"), page("beta")]) {
    await run(vault.ingestAcceptedPage({
      revisionId: `revision-${accepted.id}-1`,
      markdown: serializeMemoryMarkdown(accepted),
      actorId: "seed-author",
      createdAt: "2026-07-01T00:00:00.000Z"
    }))
  }
  return vault
}

class TestDurableObjectId implements DurableObjectIdLike {
  constructor(readonly name: string) {}

  toString(): string {
    return this.name
  }
}

class SharedVaultNamespace implements DurableObjectNamespaceLike {
  private readonly vaults = new Map<string, Promise<TeamVault>>()

  constructor(private readonly bucket: InMemoryR2Bucket) {}

  idFromName(name: string): DurableObjectIdLike {
    return new TestDurableObjectId(name)
  }

  vault(organizationId: string): Promise<TeamVault> {
    let vault = this.vaults.get(organizationId)
    if (vault === undefined) {
      vault = run(TeamVault.create(organizationId, new InMemoryVaultState(), this.bucket))
      this.vaults.set(organizationId, vault)
    }
    return vault
  }

  get(id: DurableObjectIdLike): DurableObjectStubLike {
    const organizationId = id.name
    if (organizationId === undefined) throw new Error("missing test organization")
    return {
      fetch: async (request) => {
        if (request.headers.get(VAULT_ORGANIZATION_HEADER) !== organizationId) {
          return new Response("scope mismatch", { status: 403 })
        }
        return handleTeamVaultRequest(request, await this.vault(organizationId))
      }
    }
  }
}

class TestWorkflowInstance implements WorkflowInstanceLike {
  constructor(
    readonly id: string,
    private value: WorkflowInstanceStatusLike
  ) {}

  async status(): Promise<WorkflowInstanceStatusLike> {
    return this.value
  }

  async sendEvent(event: { readonly type: string; readonly payload: unknown }): Promise<void> {
    this.value = { status: "complete", output: event.payload }
  }
}

class SharedCompilerBinding implements WorkflowBindingLike<CompilerWorkflowInput> {
  private readonly instances = new Map<string, TestWorkflowInstance>()

  constructor(private readonly output: unknown) {}

  async create(options: {
    readonly id: string
    readonly params: CompilerWorkflowInput
  }): Promise<WorkflowInstanceLike> {
    const existing = this.instances.get(options.id)
    if (existing !== undefined) return existing
    const instance = new TestWorkflowInstance(options.id, { status: "complete", output: this.output })
    this.instances.set(options.id, instance)
    return instance
  }

  async get(id: string): Promise<WorkflowInstanceLike> {
    const instance = this.instances.get(id)
    if (instance === undefined) throw new Error("workflow not found")
    return instance
  }
}

const serviceRequest = (path: string, method = "GET", body?: unknown): Request =>
  new Request(`https://memory.test${path}`, {
    method,
    headers: {
      authorization: "Bearer service-secret",
      "content-type": "application/json",
      "x-jingler-organization-id": "org-compiler"
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  })

describe("durable memory compiler workflow", () => {
  it("compiles a stored source with the bounded deterministic model", async () => {
    const vault = await seedVault()
    const result = await runCompilerWorkflow(
      { ...workflowInput, workflowId: "compiler-default" },
      new VaultCompilerRepository(vault),
      new ImmediateStep()
    )
    expect(result.status).toBe("pending_review")
    const proposals = (await run(vault.snapshot())).proposals
    expect(proposals.length).toBeGreaterThan(0)
    expect(proposals.length).toBeLessThanOrEqual(3)
    expect(proposals.every((proposal) => proposal.markdown.includes(compilerSource.id))).toBe(true)
    expect((await run(vault.listPages())).every((head) => head.revision === 1)).toBe(true)
  })

  it("creates a new cited page when the vault is empty", async () => {
    const vault = await run(TeamVault.create(
      "org-compiler",
      new InMemoryVaultState(),
      new InMemoryR2Bucket()
    ))
    await run(vault.ingestSource(
      compilerSource,
      "A refund retry must preserve the idempotency key for every network attempt."
    ))
    const result = await runCompilerWorkflow(
      { ...workflowInput, workflowId: "compiler-new-page" },
      new VaultCompilerRepository(vault),
      new ImmediateStep()
    )
    expect(result.status).toBe("pending_review")
    const [proposal] = (await run(vault.snapshot())).proposals
    expect(proposal).toMatchObject({ baseRevisionId: "new", path: expect.stringMatching(/^learnings\//) })
    const approval = await run(vault.approveProposalSet(
      result.proposalId,
      "reviewer-new-page",
      "2026-08-01T12:00:00.000Z"
    ))
    expect(approval.status).toBe("accepted")
    expect(await run(vault.listPages())).toEqual([
      expect.objectContaining({ pageId: expect.stringMatching(/^learning-/), revision: 1 })
    ])
  })

  it("creates a cited multi-page pending proposal without moving accepted heads and retries idempotently", async () => {
    const vault = await seedVault()
    const repository = new VaultCompilerRepository(vault)
    const model = new FixtureModel()
    let loseFirstResponse = true
    const flaky: CompilerRepository = {
      ...repository,
      readSource: (sourceId) => repository.readSource(sourceId),
      listAcceptedPages: () => repository.listAcceptedPages(),
      readNavigation: () => repository.readNavigation(),
      approveProposalSet: (id, reviewer, at) => repository.approveProposalSet(id, reviewer, at),
      createProposalSet: async (input) => {
        const created = await repository.createProposalSet(input)
        if (loseFirstResponse) {
          loseFirstResponse = false
          throw new Error("simulated lost workflow response")
        }
        return created
      }
    }

    await expect(runCompilerWorkflow(workflowInput, flaky, new ImmediateStep(), model)).rejects.toThrow(
      "simulated lost workflow response"
    )
    const result = await runCompilerWorkflow(workflowInput, flaky, new ImmediateStep(), model)
    expect(result).toMatchObject({
      workflowId: workflowInput.workflowId,
      status: "pending_review",
      proposalId: `proposal:${workflowInput.workflowId}`
    })
    expect((await run(vault.snapshot())).proposalSets).toHaveLength(1)
    expect((await run(vault.snapshot())).proposals).toHaveLength(2)
    expect((await run(vault.listPages())).map((head) => head.revision)).toEqual([1, 1])
    for (const proposal of (await run(vault.snapshot())).proposals) {
      expect(proposal.status).toBe("open")
      expect(proposal.markdown).toContain(`"sourceId":"${compilerSource.id}"`)
    }
  })

  it("publishes all intended heads together and regenerates every accepted projection", async () => {
    const bucket = new InMemoryR2Bucket()
    const vault = await seedVault(bucket)
    const result = await runCompilerWorkflow(
      workflowInput,
      new VaultCompilerRepository(vault),
      new ImmediateStep(),
      new FixtureModel()
    )
    if (result.status !== "pending_review") throw new Error("expected pending review")
    const before = await run(captureVaultDerivedFingerprints(vault, "2026-08-02T00:00:00.000Z"))
    const approval = await run(vault.approveProposalSet(
      result.proposalId,
      "reviewer-1",
      "2026-08-01T12:00:00.000Z"
    ))
    expect(approval.status).toBe("accepted")
    expect((await run(vault.listPages())).map((head) => head.revision)).toEqual([2, 2])
    expect(await run(vault.search("reversible rollout", 10, "2026-08-02T00:00:00.000Z"))).toMatchObject({
      total: 1,
      results: [{ pageId: "beta", revision: 2 }]
    })
    const navigation = await run(vault.navigation())
    expect(navigation.indexMarkdown).toContain("backlinks: alpha")
    expect(navigation.logMarkdown).toContain("alpha@2")
    expect(navigation.logMarkdown).toContain("beta@2")
    const graph = await run(vault.graph({ limit: 20 }, "2026-08-02T00:00:00.000Z"))
    expect(graph.edges.some((edge) => edge.kind === "wikilink" && edge.sourceId === "page:alpha")).toBe(
      true
    )
    const dashboard = await run(vault.dashboard("2026-08-02T00:00:00.000Z"))
    expect(dashboard.growth.revisions).toBe(4)
    expect(dashboard.reviewThroughput).toMatchObject({ proposed: 2, accepted: 2, open: 0 })
    const after = await run(captureVaultDerivedFingerprints(vault, "2026-08-02T00:00:00.000Z"))
    expect(after).not.toEqual(before)
    const reconciled = await run(reconcileVaultFromR2(vault, "2026-08-02T00:00:00.000Z"))
    expect(reconciled.converged).toBe(true)

    const rebuilt = await run(TeamVault.create("org-compiler", new InMemoryVaultState(), bucket))
    expect(await run(rebuilt.rebuildFromR2())).toEqual({ pages: 2, revisions: 4, sources: 2 })
    expect((await run(rebuilt.listPages())).map((head) => head.revision)).toEqual([2, 2])
    const rebuiltSnapshot = await run(rebuilt.snapshot())
    expect(rebuiltSnapshot.proposals.every((proposal) => proposal.status === "accepted")).toBe(true)
    expect(rebuiltSnapshot.events.some((event) => event.type === "proposal.accepted")).toBe(true)
    expect((await run(rebuilt.dashboard("2026-08-02T00:00:00.000Z"))).retrieval.searches).toBeGreaterThan(0)
  })

  it("resumes a paused factual workflow from its explicit review event", async () => {
    const vault = await seedVault()
    const step = new AcceptedReviewStep(async () => {
      const proposalId = `proposal:${workflowInput.workflowId}`
      const approval = await run(vault.approveProposalSet(
        proposalId,
        "reviewer-resume",
        "2026-08-01T12:00:00.000Z"
      ))
      expect(approval.status).toBe("accepted")
    })
    const result = await runCompilerWorkflow(
      workflowInput,
      new VaultCompilerRepository(vault),
      step,
      new FixtureModel()
    )
    expect(result.status).toBe("published")
    expect((await run(vault.listPages())).map((head) => head.revision)).toEqual([2, 2])
  })

  it("supersedes a stale proposal set without partially publishing unaffected pages", async () => {
    const vault = await seedVault()
    const repository = new VaultCompilerRepository(vault)
    const result = await runCompilerWorkflow(
      workflowInput,
      repository,
      new ImmediateStep(),
      new FixtureModel()
    )
    if (result.status !== "pending_review") throw new Error("expected pending review")
    const acceptedAlpha = await run(vault.readPage("alpha"))
    await run(vault.createProposal({
      id: "competing-alpha",
      pageId: "alpha",
      baseRevisionId: acceptedAlpha.revision.id,
      markdown: serializeMemoryMarkdown(
        compiledPage(
          acceptedAlpha.page,
          "# Alpha rollout\n\nA newer alpha decision was accepted. [@alpha-session]\n"
        )
      ),
      proposedBy: "other-author",
      createdAt: "2026-08-01T11:00:00.000Z"
    }))
    expect(
      await run(vault.approveProposal("competing-alpha", "reviewer", "2026-08-01T11:30:00.000Z"))
    ).toMatchObject({ status: "accepted" })

    const stale = await run(vault.approveProposalSet(
      result.proposalId,
      "reviewer",
      "2026-08-01T12:00:00.000Z"
    ))
    expect(stale).toMatchObject({ status: "conflict", conflicts: [{ pageId: "alpha" }] })
    expect((await run(vault.readPage("alpha"))).page.body).toContain("newer alpha decision")
    expect((await run(vault.readPage("beta"))).page.revision).toBe(1)
    expect((await run(vault.getProposalSet(result.proposalId))).status).toBe("superseded")
  })

  it("ignores uncommitted publication revisions during R2 reconciliation", async () => {
    const bucket = new InMemoryR2Bucket()
    await seedVault(bucket)
    const objects = new MemoryR2Store("org-compiler", bucket)
    await objects.putAcceptedRevision(
      serializeMemoryMarkdown(
        compiledPage(
          page("alpha"),
          "# Alpha rollout\n\nAn interrupted publication must remain invisible. [@alpha-session]\n"
        )
      ),
      {
        id: "revision-uncommitted-alpha",
        pageId: "alpha",
        revision: 2,
        parentRevisionId: "revision-alpha-1",
        authorId: "interrupted-worker",
        createdAt: "2026-08-01T12:00:00.000Z",
        acceptedAt: "2026-08-01T12:00:00.000Z",
        publicationId: "proposal:interrupted"
      }
    )
    const rebuilt = await run(TeamVault.create("org-compiler", new InMemoryVaultState(), bucket))
    expect(await run(rebuilt.rebuildFromR2())).toEqual({ pages: 2, revisions: 2, sources: 2 })
    expect((await run(rebuilt.readPage("alpha"))).page.revision).toBe(1)
  })

  it("polls and reviews by durable handles across independent stateless API instances", async () => {
    const bucket = new InMemoryR2Bucket()
    const namespace = new SharedVaultNamespace(bucket)
    const vault = await namespace.vault("org-compiler")
    await run(vault.ingestSource(baseSource, "Base evidence"))
    await run(vault.ingestSource(compilerSource, "Alpha and beta have a durable workflow."))
    for (const accepted of [page("alpha"), page("beta")]) {
      await run(vault.ingestAcceptedPage({
        revisionId: `revision-${accepted.id}-1`,
        markdown: serializeMemoryMarkdown(accepted),
        actorId: "seed-author",
        createdAt: "2026-07-01T00:00:00.000Z"
      }))
    }
    const workflow = await runCompilerWorkflow(
      workflowInput,
      new VaultCompilerRepository(vault),
      new ImmediateStep(),
      new FixtureModel()
    )
    if (workflow.status !== "pending_review") throw new Error("expected pending review")
    const binding = new SharedCompilerBinding(workflow)
    const firstInstance: MemoryWorkerEnv = {
      MEMORY_R2: bucket,
      MEMORY_VAULTS: namespace,
      MEMORY_SERVICE_SECRET: "service-secret",
      MEMORY_COMPILER: binding
    }
    const secondInstance: MemoryWorkerEnv = { ...firstInstance }

    const captured = await handleMemoryWorkerRequest(
      serviceRequest("/internal/memory/sources", "POST", {
        source: compilerSource,
        content: "Alpha and beta have a durable workflow."
      }),
      firstInstance
    )
    const capturedBody: unknown = await captured.json()
    expect(capturedBody).toMatchObject({ source: { id: compilerSource.id } })
    if (
      typeof capturedBody !== "object" ||
      capturedBody === null ||
      !("workflowId" in capturedBody) ||
      typeof capturedBody.workflowId !== "string"
    ) {
      throw new Error("source capture did not return a workflow handle")
    }
    const capturedPoll = await handleMemoryWorkerRequest(
      serviceRequest(`/internal/memory/workflows/${capturedBody.workflowId}`),
      secondInstance
    )
    expect(await capturedPoll.json()).toMatchObject({ state: "complete" })

    const started = await handleMemoryWorkerRequest(
      serviceRequest("/internal/memory/workflows/compiler", "POST", {
        workflowId: workflowInput.workflowId,
        sourceId: workflowInput.sourceId,
        requestedBy: workflowInput.requestedBy,
        createdAt: workflowInput.createdAt
      }),
      firstInstance
    )
    expect(await started.json()).toEqual({ status: "queued", workflowId: workflowInput.workflowId })

    const firstPoll = await handleMemoryWorkerRequest(
      serviceRequest(`/internal/memory/workflows/${workflowInput.workflowId}`),
      secondInstance
    )
    const secondPoll = await handleMemoryWorkerRequest(
      serviceRequest(`/internal/memory/workflows/${workflowInput.workflowId}`),
      secondInstance
    )
    expect(await firstPoll.clone().json()).toEqual(await secondPoll.json())
    expect(await firstPoll.json()).toMatchObject({
      workflowId: workflowInput.workflowId,
      state: "complete",
      result: { status: "pending_review", proposalId: workflow.proposalId }
    })

    const reviewed = await handleMemoryWorkerRequest(
      serviceRequest(
        `/internal/memory/proposals/${encodeURIComponent(workflow.proposalId)}/approve`,
        "POST",
        { reviewerId: "reviewer-next-instance", acceptedAt: "2026-08-01T12:00:00.000Z" }
      ),
      secondInstance
    )
    expect(await reviewed.json()).toMatchObject({ status: "accepted", proposalSetId: workflow.proposalId })
    expect((await run(vault.listPages())).map((head) => head.revision)).toEqual([2, 2])
    const resumed = await handleMemoryWorkerRequest(
      serviceRequest(`/internal/memory/workflows/${workflowInput.workflowId}`),
      firstInstance
    )
    expect(await resumed.json()).toMatchObject({
      state: "complete",
      result: { status: "accepted", proposalId: workflow.proposalId }
    })
  })

  it("auto-publishes only configured changes that are mechanically equivalent", async () => {
    const unsafeVault = await seedVault()
    const unsafeModel: CompilerModel = {
      generate: async (context) => ({
        ...(await new FixtureModel().generate(context)),
        changeKind: "mechanical"
      })
    }
    const unsafe = await runCompilerWorkflow(
      { ...workflowInput, workflowId: "compiler-unsafe-mechanical", autoPublishFixes: ["canonical-markdown"] },
      new VaultCompilerRepository(unsafeVault),
      new ImmediateStep(),
      unsafeModel
    )
    expect(unsafe.status).toBe("pending_review")
    expect((await run(unsafeVault.listPages())).map((head) => head.revision)).toEqual([1, 1])

    const safeVault = await seedVault()
    const safeModel: CompilerModel = {
      generate: async (context) => {
        const accepted = context.candidates.find((candidate) => candidate.page.id === "alpha")!
        return {
          changeKind: "mechanical",
          drafts: [
            {
              pageId: accepted.page.id,
              baseRevisionId: accepted.revisionId,
              markdown: serializeMemoryMarkdown({
                ...accepted.page,
                revision: accepted.page.revision + 1,
                citations: [
                  ...accepted.page.citations,
                  { id: "alpha-session", sourceId: compilerSource.id }
                ]
              })
            }
          ]
        }
      }
    }
    const safe = await runCompilerWorkflow(
      { ...workflowInput, workflowId: "compiler-safe-mechanical", autoPublishFixes: ["canonical-markdown"] },
      new VaultCompilerRepository(safeVault),
      new ImmediateStep(),
      safeModel
    )
    expect(safe.status).toBe("published")
    expect((await run(safeVault.readPage("alpha"))).page.revision).toBe(2)
  })
})
