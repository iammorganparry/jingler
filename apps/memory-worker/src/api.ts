import { MemoryRetrievalSummary } from "@jingler/core"
import { MemorySource, canonicalJson, stableContentHash } from "@jingler/memory"
import { Effect, Either, Match, Schema } from "effect"
import {
  ORGANIZATION_HEADER,
  VAULT_ORGANIZATION_HEADER,
  MemoryAuthenticationError,
  assertVaultOrganization,
  authenticateInternalRequest
} from "./auth.js"
import type { DurableObjectStateLike, MemoryWorkerEnv, TeamVaultEnv } from "./env.js"
import {
  MemoryVaultError,
  SqliteVaultState,
  TeamVault,
  type ApprovalResult,
  type ProposalSetApprovalResult
} from "./team-vault.js"

const NonEmptyString = Schema.String.pipe(Schema.minLength(1))

const AcceptedPageRequest = Schema.Struct({
  revisionId: NonEmptyString,
  markdown: NonEmptyString,
  actorId: NonEmptyString,
  createdAt: NonEmptyString
})

const SourceRequest = Schema.Struct({
  source: MemorySource,
  content: NonEmptyString,
  retrieval: Schema.optionalWith(MemoryRetrievalSummary, {
    default: () => ({ searches: 0, reads: 0, navigation: 0, graphReads: 0, proposals: 0 })
  })
})

const SourceResponse = Schema.Struct({
  source: MemorySource,
  contentHash: Schema.String,
  contentKey: Schema.String
})

const ProposalRequest = Schema.Struct({
  id: NonEmptyString,
  pageId: NonEmptyString,
  baseRevisionId: NonEmptyString,
  markdown: NonEmptyString,
  proposedBy: NonEmptyString,
  createdAt: NonEmptyString,
  summary: Schema.optional(Schema.String)
})

const ProposalDraftRequest = Schema.Struct({
  pageId: NonEmptyString,
  baseRevisionId: NonEmptyString,
  markdown: NonEmptyString,
  summary: Schema.optional(Schema.String)
})

const ProposalSetRequest = Schema.Struct({
  id: NonEmptyString,
  workflowId: NonEmptyString,
  sourceId: NonEmptyString,
  proposedBy: NonEmptyString,
  createdAt: NonEmptyString,
  changeKind: Schema.Literal("factual", "mechanical"),
  drafts: Schema.Array(ProposalDraftRequest)
})

const ApprovalRequest = Schema.Struct({
  reviewerId: NonEmptyString,
  acceptedAt: NonEmptyString
})

const RejectionRequest = Schema.Struct({
  reviewerId: NonEmptyString,
  rejectedAt: NonEmptyString
})

const CompilerWorkflowRequest = Schema.Struct({
  workflowId: NonEmptyString,
  sourceId: NonEmptyString,
  requestedBy: NonEmptyString,
  createdAt: NonEmptyString
})

const LintWorkflowRequest = Schema.Struct({
  workflowId: NonEmptyString,
  asOf: NonEmptyString
})

const ReviewSignalResponse = Schema.Struct({
  status: Schema.Literal("accepted", "rejected", "conflict")
})

const jsonResponse = (value: unknown, status = 200): Response =>
  new Response(canonicalJson(value), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" }
  })

const errorResponse = (error: unknown): Response =>
  Match.value(error).pipe(
    Match.when(Match.instanceOf(MemoryAuthenticationError), (failure) =>
      jsonResponse({ error: failure.message, code: "unauthorized" }, failure.status)
    ),
    Match.when(Match.instanceOf(MemoryVaultError), (failure) =>
      jsonResponse({ error: failure.message, code: failure.code }, failure.status)
    ),
    Match.orElse(() =>
      jsonResponse({ error: "memory service failed", code: "internal_error" }, 500)
    )
  )

const decodeRequest = <Decoded, Encoded>(
  request: { text(): Promise<string> },
  schema: Schema.Schema<Decoded, Encoded>
): Promise<Decoded> => {
  const decoded = Effect.runPromise(
    Effect.tryPromise({
      try: () => request.text(),
      catch: (error) =>
        new MemoryVaultError("invalid", `request body must be JSON: ${String(error)}`)
    }).pipe(
      Effect.flatMap(Schema.decodeUnknown(Schema.parseJson(schema))),
      Effect.mapError((error) =>
        error instanceof MemoryVaultError
          ? error
          : new MemoryVaultError("invalid", `request body is invalid: ${String(error)}`)
      ),
      Effect.either
    )
  )
  return decoded.then((result) => {
    if (Either.isLeft(result)) throw result.left
    return result.right
  })
}

const positiveLimit = (url: URL, key = "limit"): number | undefined => {
  const raw = url.searchParams.get(key)
  if (raw === null) return
  const value = Number(raw)
  if (!Number.isFinite(value) || value < 1) {
    throw new MemoryVaultError("invalid", `${key} must be a positive number`)
  }
  return Math.floor(value)
}

const nonNegativeCursor = (url: URL): number | undefined => {
  const raw = url.searchParams.get("cursor")
  if (raw === null) return
  const value = Number(raw)
  if (!Number.isInteger(value) || value < 0) {
    throw new MemoryVaultError("invalid", "cursor must be a non-negative integer")
  }
  return value
}

const pathSegments = (url: URL): ReadonlyArray<string> =>
  url.pathname
    .split("/")
    .filter((segment) => segment !== "")
    .map((segment) => decodeURIComponent(segment))

const isRoute = (
  request: Request,
  route: ReadonlyArray<string>,
  method: string,
  ...segments: ReadonlyArray<string>
): boolean =>
  request.method === method &&
  route.length === segments.length &&
  segments.every((segment, index) => route[index] === segment)

const fallbackOnMissing = async <Primary, Fallback>(
  primary: () => Promise<Primary>,
  fallback: () => Promise<Fallback>
): Promise<Primary | Fallback> => {
  try {
    return await primary()
  } catch (error) {
    if (!(error instanceof MemoryVaultError) || error.code !== "not_found") throw error
    return fallback()
  }
}

const configuredMechanicalFixes = (env: MemoryWorkerEnv): ReadonlyArray<string> =>
  (env.MEMORY_AUTO_PUBLISH_FIXES ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter((value) => value.length > 0)

const runRequest = (operation: () => Promise<Response>): Promise<Response> =>
  Effect.runPromise(
    Effect.tryPromise({ try: operation, catch: (error) => error }).pipe(
      Effect.catchAll((error) => Effect.succeed(errorResponse(error)))
    )
  )

const notFoundResponse = (): Response =>
  jsonResponse({ error: "not found", code: "not_found" }, 404)

const dispatchPageRequest = async (
  request: Request,
  route: ReadonlyArray<string>,
  vault: TeamVault
): Promise<Response> => {
  if (isRoute(request, route, "GET", "pages")) {
    return jsonResponse({ pages: await vault.listPages() })
  }
  if (isRoute(request, route, "POST", "pages")) {
    return jsonResponse(await vault.ingestAcceptedPage(await decodeRequest(request, AcceptedPageRequest)), 201)
  }
  if (isRoute(request, route, "GET", "pages", route[1] ?? "")) {
    return jsonResponse(await vault.readPage(route[1] ?? ""))
  }
  return notFoundResponse()
}

const dispatchSourceRequest = async (
  request: Request,
  route: ReadonlyArray<string>,
  vault: TeamVault
): Promise<Response> => {
  if (isRoute(request, route, "POST", "sources")) {
    const body = await decodeRequest(request, SourceRequest)
    return jsonResponse(await vault.ingestSource(body.source, body.content, body.retrieval), 201)
  }
  if (isRoute(request, route, "GET", "sources")) {
    return jsonResponse({ sources: await vault.listSources() })
  }
  if (isRoute(request, route, "GET", "sources", route[1] ?? "")) {
    return jsonResponse(await vault.readSource(route[1] ?? ""))
  }
  return notFoundResponse()
}

const dispatchProposalSetRequest = async (
  request: Request,
  route: ReadonlyArray<string>,
  vault: TeamVault
): Promise<Response> => {
  if (isRoute(request, route, "POST", "proposal-sets")) {
    return jsonResponse(await vault.createProposalSet(await decodeRequest(request, ProposalSetRequest)), 201)
  }
  if (isRoute(request, route, "GET", "proposal-sets", route[1] ?? "")) {
    return jsonResponse(await vault.getProposalSet(route[1] ?? ""))
  }
  if (isRoute(request, route, "POST", "proposal-sets", route[1] ?? "", "approve")) {
    const body = await decodeRequest(request, ApprovalRequest)
    const result = await vault.approveProposalSet(
      route[1] ?? "",
      body.reviewerId,
      body.acceptedAt
    )
    return jsonResponse(result, result.status === "accepted" ? 200 : 409)
  }
  if (isRoute(request, route, "POST", "proposal-sets", route[1] ?? "", "reject")) {
    const body = await decodeRequest(request, RejectionRequest)
    return jsonResponse(
      await vault.rejectProposalSet(route[1] ?? "", body.reviewerId, body.rejectedAt)
    )
  }
  return notFoundResponse()
}

const dispatchProposalRequest = async (
  request: Request,
  route: ReadonlyArray<string>,
  vault: TeamVault
): Promise<Response> => {
  if (isRoute(request, route, "POST", "proposals")) {
    return jsonResponse(await vault.createProposal(await decodeRequest(request, ProposalRequest)), 201)
  }
  if (isRoute(request, route, "GET", "proposals", route[1] ?? "")) {
    return jsonResponse(await vault.getProposal(route[1] ?? ""))
  }
  if (isRoute(request, route, "POST", "proposals", route[1] ?? "", "approve")) {
    const body = await decodeRequest(request, ApprovalRequest)
    const proposalId = route[1] ?? ""
    const result: ApprovalResult | ProposalSetApprovalResult = await fallbackOnMissing(
      () => vault.approveProposal(proposalId, body.reviewerId, body.acceptedAt),
      () => vault.approveProposalSet(proposalId, body.reviewerId, body.acceptedAt)
    )
    return jsonResponse(result, result.status === "accepted" ? 200 : 409)
  }
  if (isRoute(request, route, "POST", "proposals", route[1] ?? "", "reject")) {
    const body = await decodeRequest(request, RejectionRequest)
    const proposalId = route[1] ?? ""
    return jsonResponse(
      await fallbackOnMissing(
        () => vault.rejectProposal(proposalId, body.reviewerId, body.rejectedAt),
        () => vault.rejectProposalSet(proposalId, body.reviewerId, body.rejectedAt)
      )
    )
  }
  return notFoundResponse()
}

const dispatchVaultQuery = async (
  request: Request,
  route: ReadonlyArray<string>,
  url: URL,
  vault: TeamVault
): Promise<Response> => {
  if (isRoute(request, route, "GET", "workflows", route[1] ?? "")) {
    return jsonResponse(await vault.getProposal(route[1] ?? ""))
  }
  if (isRoute(request, route, "GET", "search")) {
    const query = url.searchParams.get("q") ?? ""
    const occurredAt = url.searchParams.get("occurredAt") ?? new Date().toISOString()
    return jsonResponse(await vault.search(query, positiveLimit(url), occurredAt))
  }
  if (isRoute(request, route, "GET", "navigation")) {
    return jsonResponse(await vault.navigation())
  }
  if (isRoute(request, route, "GET", "export")) {
    return jsonResponse(await vault.exportVault())
  }
  if (isRoute(request, route, "GET", "analytics")) {
    return jsonResponse(await vault.dashboard(url.searchParams.get("asOf") ?? new Date().toISOString()))
  }
  if (isRoute(request, route, "GET", "reviews")) {
    return jsonResponse({ reviews: await vault.listProposalSets(positiveLimit(url) ?? 50) })
  }
  if (isRoute(request, route, "POST", "rebuild")) {
    return jsonResponse(await vault.rebuildFromR2())
  }
  return dispatchGraphQuery(request, route, url, vault)
}

const dispatchGraphQuery = async (
  request: Request,
  route: ReadonlyArray<string>,
  url: URL,
  vault: TeamVault
): Promise<Response> => {
  if (isRoute(request, route, "GET", "graph")) {
    return jsonResponse(
      await vault.graph(
        { limit: positiveLimit(url), cursor: nonNegativeCursor(url) },
        url.searchParams.get("asOf") ?? undefined
      )
    )
  }
  if (isRoute(request, route, "GET", "neighborhood", route[1] ?? "")) {
    return jsonResponse(
      await vault.neighborhood(
        route[1] ?? "",
        positiveLimit(url),
        url.searchParams.get("asOf") ?? undefined
      )
    )
  }
  if (isRoute(request, route, "GET", "edges", route[1] ?? "", "evidence")) {
    return jsonResponse(await vault.edgeEvidence(route[1] ?? ""))
  }
  return notFoundResponse()
}

const dispatchVaultRequest = (request: Request, vault: TeamVault): Promise<Response> => {
  const url = new URL(request.url)
  const segments = pathSegments(url)
  if (segments[0] !== "internal" || segments[1] !== "memory") {
    return Promise.resolve(notFoundResponse())
  }
  const route = segments.slice(2)
  return Match.value(route[0]).pipe(
    Match.when("pages", () => dispatchPageRequest(request, route, vault)),
    Match.when("sources", () => dispatchSourceRequest(request, route, vault)),
    Match.when("proposal-sets", () => dispatchProposalSetRequest(request, route, vault)),
    Match.when("proposals", () => dispatchProposalRequest(request, route, vault)),
    Match.orElse(() => dispatchVaultQuery(request, route, url, vault))
  )
}

export const handleTeamVaultRequest = (request: Request, vault: TeamVault): Promise<Response> =>
  runRequest(() => dispatchVaultRequest(request, vault))

const startCompilerWorkflow = async (
  request: Request,
  env: MemoryWorkerEnv,
  organizationId: string
): Promise<Response> => {
  const body = await decodeRequest(request, CompilerWorkflowRequest)
  if (!body.workflowId.startsWith("compiler-")) {
    throw new MemoryVaultError("invalid", "compiler workflow ids must start with compiler-")
  }
  if (env.MEMORY_COMPILER === undefined) {
    throw new MemoryVaultError("not_found", "compiler workflow binding is unavailable", 404)
  }
  const instance = await env.MEMORY_COMPILER.create({
    id: body.workflowId,
    params: {
      ...body,
      organizationId,
      autoPublishFixes: configuredMechanicalFixes(env)
    }
  })
  return jsonResponse({ workflowId: instance.id, status: "queued" }, 202)
}

const startLintWorkflow = async (
  request: Request,
  env: MemoryWorkerEnv,
  organizationId: string
): Promise<Response> => {
  const body = await decodeRequest(request, LintWorkflowRequest)
  if (!body.workflowId.startsWith("lint-")) {
    throw new MemoryVaultError("invalid", "lint workflow ids must start with lint-")
  }
  if (env.MEMORY_LINT === undefined) {
    throw new MemoryVaultError("not_found", "lint workflow binding is unavailable", 404)
  }
  const instance = await env.MEMORY_LINT.create({
    id: body.workflowId,
    params: { ...body, organizationId }
  })
  return jsonResponse({ workflowId: instance.id, status: "queued" }, 202)
}

const startWorkflow = (
  request: Request,
  route: ReadonlyArray<string>,
  env: MemoryWorkerEnv,
  organizationId: string
): Promise<Response> | undefined => {
  if (!isRoute(request, route, "POST", "workflows", route[1] ?? "")) return
  return Match.value(route[1]).pipe(
    Match.when("compiler", () => startCompilerWorkflow(request, env, organizationId)),
    Match.when("lint", () => startLintWorkflow(request, env, organizationId)),
    Match.orElse((kind) => {
      throw new MemoryVaultError("invalid", `unknown workflow kind ${kind ?? ""}`)
    })
  )
}

const readWorkflow = async (
  request: Request,
  route: ReadonlyArray<string>,
  env: MemoryWorkerEnv
): Promise<Response | undefined> => {
  if (!isRoute(request, route, "GET", "workflows", route[1] ?? "")) return
  const workflowId = route[1] ?? ""
  const knownKind = workflowId.startsWith("lint-") || workflowId.startsWith("compiler-")
  const binding = workflowId.startsWith("lint-") ? env.MEMORY_LINT : env.MEMORY_COMPILER
  if (!knownKind || binding === undefined) return
  try {
    const status = await (await binding.get(workflowId)).status()
    const pendingResult = workflowId.startsWith("compiler-")
      ? {
          status: "pending_review",
          workflowId,
          proposalId: `proposal:${workflowId}`,
          proposalIds: []
        }
      : null
    return jsonResponse({ workflowId, state: status.status, result: status.output ?? pendingResult })
  } catch {
    throw new MemoryVaultError("not_found", `workflow ${workflowId} was not found`, 404)
  }
}

const startCompilerForSource = async (
  request: Request,
  response: Response,
  env: MemoryWorkerEnv,
  organizationId: string
): Promise<string | undefined> => {
  if (!response.ok || env.MEMORY_COMPILER === undefined) return
  let source: MemorySource
  try {
    source = (await decodeRequest(request, SourceRequest)).source
  } catch {
    return
  }
  const workflowId = `compiler-${stableContentHash(`${organizationId}\u0000${source.id}`)}`
  try {
    await env.MEMORY_COMPILER.create({
      id: workflowId,
      params: {
        workflowId,
        organizationId,
        sourceId: source.id,
        requestedBy: "agent:session-capture",
        createdAt: source.retrievedAt ?? new Date().toISOString(),
        autoPublishFixes: configuredMechanicalFixes(env)
      }
    })
  } catch {
    // Duplicate delivery reuses this deterministic handle; other failures remain fail-open.
  }
  return workflowId
}

const signalCompilerReview = async (
  route: ReadonlyArray<string>,
  response: Response,
  env: MemoryWorkerEnv
): Promise<void> => {
  const proposalId = route[1]
  if (
    env.MEMORY_COMPILER === undefined ||
    route.length !== 3 ||
    (route[0] !== "proposals" && route[0] !== "proposal-sets") ||
    (route[2] !== "approve" && route[2] !== "reject") ||
    proposalId === undefined ||
    !proposalId.startsWith("proposal:compiler-")
  ) {
    return
  }
  try {
    const { status } = await decodeRequest(response.clone(), ReviewSignalResponse)
    const workflowId = proposalId.slice("proposal:".length)
    const instance = await env.MEMORY_COMPILER.get(workflowId)
    await instance.sendEvent?.({
      type: `review:${proposalId}`,
      payload: { status, proposalId }
    })
  } catch {
    // Publication is durable; an idempotent review retry can re-signal a waiting workflow.
  }
}

const forwardVaultRequest = async (
  request: Request,
  route: ReadonlyArray<string>,
  env: MemoryWorkerEnv,
  organizationId: string
): Promise<Response> => {
  const id = env.MEMORY_VAULTS.idFromName(organizationId)
  const headers = new Headers(request.headers)
  headers.delete("authorization")
  headers.delete(ORGANIZATION_HEADER)
  headers.set(VAULT_ORGANIZATION_HEADER, organizationId)
  const sourceRequest =
    isRoute(request, route, "POST", "sources")
      ? request.clone()
      : undefined
  const response = await env.MEMORY_VAULTS.get(id).fetch(new Request(request, { headers }))
  await signalCompilerReview(route, response, env)
  const startedWorkflowId =
    sourceRequest === undefined
      ? undefined
      : await startCompilerForSource(sourceRequest, response, env, organizationId)
  if (startedWorkflowId !== undefined) {
    const body = await decodeRequest(response.clone(), SourceResponse)
    return jsonResponse({ ...body, workflowId: startedWorkflowId }, response.status)
  }
  return response
}

const dispatchWorkerRequest = async (request: Request, env: MemoryWorkerEnv): Promise<Response> => {
  const { organizationId } = authenticateInternalRequest(request, env)
  const segments = pathSegments(new URL(request.url))
  const route = segments[0] === "internal" && segments[1] === "memory" ? segments.slice(2) : []
  const started = startWorkflow(request, route, env, organizationId)
  if (started !== undefined) return started
  const workflow = await readWorkflow(request, route, env)
  return workflow ?? forwardVaultRequest(request, route, env, organizationId)
}

export const handleMemoryWorkerRequest = (
  request: Request,
  env: MemoryWorkerEnv
): Promise<Response> =>
  runRequest(() => dispatchWorkerRequest(request, env))

export class TeamVaultObject {
  private organizationId: string | undefined
  private vault: Promise<TeamVault> | undefined
  private readonly initialized: Promise<void>

  constructor(
    private readonly state: DurableObjectStateLike,
    private readonly env: TeamVaultEnv
  ) {
    this.initialized = this.state.blockConcurrencyWhile(async () => {
      await new SqliteVaultState(this.state.storage.sql).initialize()
    })
  }

  async fetch(request: Request): Promise<Response> {
    try {
      await this.initialized
      const organizationId = assertVaultOrganization(request.headers.get(VAULT_ORGANIZATION_HEADER))
      if (this.organizationId !== undefined && this.organizationId !== organizationId) {
        return errorResponse(new MemoryAuthenticationError("organization scope mismatch", 403))
      }
      this.organizationId = organizationId
      this.vault ??= TeamVault.create(
        organizationId,
        new SqliteVaultState(this.state.storage.sql),
        this.env.MEMORY_R2
      )
      return await this.vault.then((vault) => handleTeamVaultRequest(request, vault))
    } catch (error) {
      return errorResponse(error)
    }
  }
}
