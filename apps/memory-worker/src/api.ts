import { MemoryAcceptedPageRequest, MemoryRetrievalSummary } from "@jingler/core"
import {
  MemorySource,
  SUGGESTION_POLICY_DEFAULT,
  canonicalJson,
  stableContentHash,
  type SuggestionPolicy
} from "@jingler/memory"
import { Effect, Either, Match, Schema } from "effect"
import { DurableObject } from "cloudflare:workers"
import {
  ORGANIZATION_HEADER,
  VAULT_ORGANIZATION_HEADER,
  MemoryAuthenticationError,
  assertVaultOrganization,
  authenticateInternalRequest,
  workflowBindingIds
} from "./auth.js"
import type {
  DurableObjectStorageLike,
  MemoryWorkerEnv,
  TeamVaultEnv,
  WorkflowBindingLike,
  WorkflowInstanceLike
} from "./env.js"
import {
  MemoryVaultError,
  SqliteVaultState,
  TeamVault,
  type ApprovalResult,
  type ProposalSetApprovalResult
} from "./team-vault.js"
import { createOpenAiEmbedderFromEnv } from "./embeddings.js"
import {
  TurbopufferVectorLayer,
  createTurbopufferClientFromEnv
} from "./turbopuffer.js"

const NonEmptyString = Schema.String.pipe(Schema.minLength(1))

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

const proposalRequestFields = {
  id: NonEmptyString,
  pageId: NonEmptyString,
  baseRevisionId: NonEmptyString,
  markdown: NonEmptyString,
  proposedBy: NonEmptyString,
  createdAt: NonEmptyString,
  summary: Schema.optional(Schema.String)
}

const ProposalRequest = Schema.Struct(proposalRequestFields)

const AutoPublishProposalRequest = Schema.Struct({
  ...proposalRequestFields,
  reviewerId: NonEmptyString,
  acceptedAt: NonEmptyString
})

const ProposalDraftRequest = Schema.Struct({
  pageId: NonEmptyString,
  baseRevisionId: NonEmptyString,
  path: Schema.optional(NonEmptyString),
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
        new MemoryVaultError({ code: "invalid", message: `request body must be JSON: ${String(error)}` })
    }).pipe(
      Effect.flatMap(Schema.decodeUnknown(Schema.parseJson(schema))),
      Effect.mapError((error) =>
        error instanceof MemoryVaultError
          ? error
          : new MemoryVaultError({ code: "invalid", message: `request body is invalid: ${String(error)}` })
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
    throw new MemoryVaultError({ code: "invalid", message: `${key} must be a positive number` })
  }
  return Math.floor(value)
}

const nonNegativeCursor = (url: URL): number | undefined => {
  const raw = url.searchParams.get("cursor")
  if (raw === null) return
  const value = Number(raw)
  if (!Number.isInteger(value) || value < 0) {
    throw new MemoryVaultError({ code: "invalid", message: "cursor must be a non-negative integer" })
  }
  return value
}

/** Bounded, advisory-only suggestion policy parsed from the query string. */
const suggestionPolicyFromQuery = (url: URL): SuggestionPolicy => {
  const minScoreRaw = url.searchParams.get("minScore")
  const minScore = minScoreRaw === null ? SUGGESTION_POLICY_DEFAULT.minScore : Number(minScoreRaw)
  if (!Number.isFinite(minScore) || minScore < 0) {
    throw new MemoryVaultError({ code: "invalid", message: "minScore must be a non-negative number" })
  }
  const topK = positiveLimit(url) ?? SUGGESTION_POLICY_DEFAULT.topK
  return {
    minScore,
    topK: Math.min(50, Math.max(1, Math.floor(topK))),
    directed: url.searchParams.get("directed") === "true",
    excludeExplicit: url.searchParams.get("excludeExplicit") !== "false"
  }
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

/**
 * Try the primary vault Effect; if it fails with a `not_found`, fall back to the
 * second. Preserves the old `fallbackOnMissing` behaviour: only `not_found`
 * routes to the fallback, every other failure (or defect) propagates unchanged.
 */
const fallbackOnMissing = <A, B>(
  primary: Effect.Effect<A, MemoryVaultError>,
  fallback: Effect.Effect<B, MemoryVaultError>
): Effect.Effect<A | B, MemoryVaultError> =>
  Effect.catchIf(primary, (error) => error.code === "not_found", () => fallback)

const configuredMechanicalFixes = (env: MemoryWorkerEnv): ReadonlyArray<string> =>
  (env.MEMORY_AUTO_PUBLISH_FIXES ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter((value) => value.length > 0)

/** Run the still-Promise-based body decoder as a typed Effect at a vault call site. */
const decodeBody = <Decoded, Encoded>(
  request: { text(): Promise<string> },
  schema: Schema.Schema<Decoded, Encoded>
): Effect.Effect<Decoded, MemoryVaultError> =>
  Effect.tryPromise({ try: () => decodeRequest(request, schema), catch: (error) => error as MemoryVaultError })

const runRequest = (operation: () => Promise<Response>): Promise<Response> =>
  Effect.runPromise(
    Effect.tryPromise({ try: operation, catch: (error) => error }).pipe(
      Effect.catchAll((error) => Effect.succeed(errorResponse(error)))
    )
  )

const notFoundResponse = (): Response =>
  jsonResponse({ error: "not found", code: "not_found" }, 404)

const dispatchPageRequest = (
  request: Request,
  route: ReadonlyArray<string>,
  vault: TeamVault
): Effect.Effect<Response, MemoryVaultError> =>
  Effect.gen(function* () {
    if (isRoute(request, route, "GET", "pages")) {
      return jsonResponse({ pages: yield* vault.listPages() })
    }
    if (isRoute(request, route, "POST", "pages")) {
      return jsonResponse(
        yield* vault.ingestAcceptedPage(yield* decodeBody(request, MemoryAcceptedPageRequest)),
        201
      )
    }
    if (isRoute(request, route, "GET", "pages", route[1] ?? "")) {
      return jsonResponse(yield* vault.readPage(route[1] ?? ""))
    }
    return notFoundResponse()
  })

const dispatchSourceRequest = (
  request: Request,
  route: ReadonlyArray<string>,
  vault: TeamVault
): Effect.Effect<Response, MemoryVaultError> =>
  Effect.gen(function* () {
    if (isRoute(request, route, "POST", "sources")) {
      const body = yield* decodeBody(request, SourceRequest)
      return jsonResponse(yield* vault.ingestSource(body.source, body.content, body.retrieval), 201)
    }
    if (isRoute(request, route, "GET", "sources")) {
      return jsonResponse({ sources: yield* vault.listSources() })
    }
    if (isRoute(request, route, "GET", "sources", route[1] ?? "")) {
      return jsonResponse(yield* vault.readSource(route[1] ?? ""))
    }
    return notFoundResponse()
  })

const dispatchProposalSetRequest = (
  request: Request,
  route: ReadonlyArray<string>,
  vault: TeamVault
): Effect.Effect<Response, MemoryVaultError> =>
  Effect.gen(function* () {
    if (isRoute(request, route, "POST", "proposal-sets")) {
      return jsonResponse(yield* vault.createProposalSet(yield* decodeBody(request, ProposalSetRequest)), 201)
    }
    if (isRoute(request, route, "GET", "proposal-sets", route[1] ?? "")) {
      return jsonResponse(yield* vault.getProposalSet(route[1] ?? ""))
    }
    if (isRoute(request, route, "POST", "proposal-sets", route[1] ?? "", "approve")) {
      const body = yield* decodeBody(request, ApprovalRequest)
      const result = yield* vault.approveProposalSet(
        route[1] ?? "",
        body.reviewerId,
        body.acceptedAt
      )
      return jsonResponse(result, result.status === "accepted" ? 200 : 409)
    }
    if (isRoute(request, route, "POST", "proposal-sets", route[1] ?? "", "reject")) {
      const body = yield* decodeBody(request, RejectionRequest)
      return jsonResponse(
        yield* vault.rejectProposalSet(route[1] ?? "", body.reviewerId, body.rejectedAt)
      )
    }
    return notFoundResponse()
  })

const dispatchProposalRequest = (
  request: Request,
  route: ReadonlyArray<string>,
  vault: TeamVault
): Effect.Effect<Response, MemoryVaultError> =>
  Effect.gen(function* () {
    if (isRoute(request, route, "POST", "proposals", "auto-publish")) {
      const body = yield* decodeBody(request, AutoPublishProposalRequest)
      yield* vault.createProposal({
        id: body.id,
        pageId: body.pageId,
        baseRevisionId: body.baseRevisionId,
        markdown: body.markdown,
        proposedBy: body.proposedBy,
        createdAt: body.createdAt,
        ...(body.summary === undefined ? {} : { summary: body.summary })
      })
      const result = yield* vault.approveProposal(
        body.id,
        body.reviewerId,
        body.acceptedAt
      )
      return jsonResponse(result, result.status === "accepted" ? 200 : 409)
    }
    if (isRoute(request, route, "POST", "proposals")) {
      return jsonResponse(yield* vault.createProposal(yield* decodeBody(request, ProposalRequest)), 201)
    }
    if (isRoute(request, route, "GET", "proposals", route[1] ?? "")) {
      return jsonResponse(yield* vault.getProposal(route[1] ?? ""))
    }
    if (isRoute(request, route, "POST", "proposals", route[1] ?? "", "approve")) {
      const body = yield* decodeBody(request, ApprovalRequest)
      const proposalId = route[1] ?? ""
      const result: ApprovalResult | ProposalSetApprovalResult = yield* fallbackOnMissing(
        vault.approveProposal(proposalId, body.reviewerId, body.acceptedAt),
        vault.approveProposalSet(proposalId, body.reviewerId, body.acceptedAt)
      )
      return jsonResponse(result, result.status === "accepted" ? 200 : 409)
    }
    if (isRoute(request, route, "POST", "proposals", route[1] ?? "", "reject")) {
      const body = yield* decodeBody(request, RejectionRequest)
      const proposalId = route[1] ?? ""
      return jsonResponse(
        yield* fallbackOnMissing(
          vault.rejectProposal(proposalId, body.reviewerId, body.rejectedAt),
          vault.rejectProposalSet(proposalId, body.reviewerId, body.rejectedAt)
        )
      )
    }
    return notFoundResponse()
  })

const dispatchVaultQuery = (
  request: Request,
  route: ReadonlyArray<string>,
  url: URL,
  vault: TeamVault
): Effect.Effect<Response, MemoryVaultError> =>
  Effect.gen(function* () {
    if (isRoute(request, route, "GET", "workflows", route[1] ?? "")) {
      return jsonResponse(yield* vault.getProposal(route[1] ?? ""))
    }
    if (isRoute(request, route, "GET", "search")) {
      const query = url.searchParams.get("q") ?? ""
      const occurredAt = url.searchParams.get("occurredAt") ?? new Date().toISOString()
      return jsonResponse(yield* vault.search(query, positiveLimit(url), occurredAt))
    }
    if (isRoute(request, route, "GET", "navigation")) {
      return jsonResponse(yield* vault.navigation())
    }
    if (isRoute(request, route, "POST", "compiler-context")) {
      const body = yield* decodeBody(request, Schema.Struct({
        claims: Schema.Array(NonEmptyString),
        preferredPageId: Schema.optional(NonEmptyString)
      }))
      return jsonResponse(yield* vault.compilerContext(body.claims, body.preferredPageId))
    }
    if (isRoute(request, route, "GET", "export")) {
      return jsonResponse(yield* vault.exportVault())
    }
    if (isRoute(request, route, "GET", "analytics")) {
      return jsonResponse(
        yield* vault.dashboard(
          url.searchParams.get("asOf") ?? new Date().toISOString(),
          url.searchParams.get("range") ?? "all"
        )
      )
    }
    if (isRoute(request, route, "GET", "reviews")) {
      return jsonResponse({ reviews: yield* vault.listProposalSets(positiveLimit(url) ?? 50) })
    }
    if (isRoute(request, route, "POST", "rebuild")) {
      return jsonResponse(yield* vault.rebuildFromR2())
    }
    // Advisory relatedness — deliberately BEFORE the graph dispatcher and kept apart
    // from it: this returns suggestions, never accepted edges.
    if (isRoute(request, route, "GET", "suggestions")) {
      return jsonResponse(
        yield* vault.suggestions(
          suggestionPolicyFromQuery(url),
          url.searchParams.get("pageId") ?? undefined
        )
      )
    }
    return yield* dispatchGraphQuery(request, route, url, vault)
  })

const dispatchGraphQuery = (
  request: Request,
  route: ReadonlyArray<string>,
  url: URL,
  vault: TeamVault
): Effect.Effect<Response, MemoryVaultError> =>
  Effect.gen(function* () {
    if (isRoute(request, route, "GET", "graph")) {
      return jsonResponse(
        yield* vault.graph(
          { limit: positiveLimit(url), cursor: nonNegativeCursor(url) },
          url.searchParams.get("asOf") ?? undefined
        )
      )
    }
    if (isRoute(request, route, "GET", "neighborhood", route[1] ?? "")) {
      return jsonResponse(
        yield* vault.neighborhood(
          route[1] ?? "",
          positiveLimit(url),
          url.searchParams.get("asOf") ?? undefined
        )
      )
    }
    if (isRoute(request, route, "GET", "edges", route[1] ?? "", "evidence")) {
      return jsonResponse(yield* vault.edgeEvidence(route[1] ?? ""))
    }
    return notFoundResponse()
  })

const dispatchVaultRequest = (
  request: Request,
  vault: TeamVault
): Effect.Effect<Response, MemoryVaultError> => {
  const url = new URL(request.url)
  const segments = pathSegments(url)
  if (segments[0] !== "internal" || segments[1] !== "memory") {
    return Effect.succeed(notFoundResponse())
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

/**
 * Run the vault dispatch Effect at the DO fetch boundary. Both a typed
 * `MemoryVaultError` (error channel) and any defect (an unexpected throw from a
 * query-string validator, an R2 rejection, or a corrupt-state guard) are routed
 * through `errorResponse`, exactly like the previous try/catch did.
 */
export const handleTeamVaultRequest = (request: Request, vault: TeamVault): Promise<Response> =>
  Effect.runPromise(
    dispatchVaultRequest(request, vault).pipe(
      Effect.catchAll((error) => Effect.succeed(errorResponse(error))),
      Effect.catchAllDefect((defect) => Effect.succeed(errorResponse(defect)))
    )
  )

export const createOrReuseWorkflow = async <Params>(
  binding: WorkflowBindingLike<Params>,
  id: string,
  params: Params
): Promise<void> => {
  try {
    await binding.create({ id, params })
  } catch (creationError) {
    try {
      await (await binding.get(id)).status()
    } catch {
      throw creationError
    }
  }
}

/**
 * Reuse a workflow created under either side of a service-secret rotation before
 * creating the current-secret binding. This keeps the public workflow id as the
 * dedupe boundary while retaining dual-secret lookup compatibility.
 */
export const createOrReuseScopedWorkflow = async <Params>(
  binding: WorkflowBindingLike<Params>,
  env: MemoryWorkerEnv,
  organizationId: string,
  workflowId: string,
  params: Params
): Promise<void> => {
  const ids = await workflowBindingIds(env, organizationId, workflowId)
  for (const id of ids) {
    try {
      await (await binding.get(id)).status()
      return
    } catch {
      continue
    }
  }
  await createOrReuseWorkflow(binding, ids[0]!, params)
}

const findWorkflowInstance = async (
  binding: { get(id: string): Promise<WorkflowInstanceLike> },
  env: MemoryWorkerEnv,
  organizationId: string,
  workflowId: string
): Promise<WorkflowInstanceLike | undefined> => {
  for (const id of await workflowBindingIds(env, organizationId, workflowId)) {
    try {
      const instance = await binding.get(id)
      await instance.status()
      return instance
    } catch {
      continue
    }
  }
}

const startCompilerWorkflow = async (
  request: Request,
  env: MemoryWorkerEnv,
  organizationId: string
): Promise<Response> => {
  const body = await decodeRequest(request, CompilerWorkflowRequest)
  if (!body.workflowId.startsWith("compiler-")) {
    throw new MemoryVaultError({ code: "invalid", message: "compiler workflow ids must start with compiler-" })
  }
  if (env.MEMORY_COMPILER === undefined) {
    throw new MemoryVaultError({ code: "not_found", message: "compiler workflow binding is unavailable", status: 404 })
  }
  await createOrReuseScopedWorkflow(env.MEMORY_COMPILER, env, organizationId, body.workflowId, {
    ...body,
    organizationId,
    autoPublishFixes: configuredMechanicalFixes(env),
    requireReview: false
  })
  return jsonResponse({ workflowId: body.workflowId, status: "queued" }, 202)
}

const startLintWorkflow = async (
  request: Request,
  env: MemoryWorkerEnv,
  organizationId: string
): Promise<Response> => {
  const body = await decodeRequest(request, LintWorkflowRequest)
  if (!body.workflowId.startsWith("lint-")) {
    throw new MemoryVaultError({ code: "invalid", message: "lint workflow ids must start with lint-" })
  }
  if (env.MEMORY_LINT === undefined) {
    throw new MemoryVaultError({ code: "not_found", message: "lint workflow binding is unavailable", status: 404 })
  }
  await createOrReuseScopedWorkflow(
    env.MEMORY_LINT,
    env,
    organizationId,
    body.workflowId,
    { ...body, organizationId }
  )
  return jsonResponse({ workflowId: body.workflowId, status: "queued" }, 202)
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
      throw new MemoryVaultError({ code: "invalid", message: `unknown workflow kind ${kind ?? ""}` })
    })
  )
}

const readWorkflow = async (
  request: Request,
  route: ReadonlyArray<string>,
  env: MemoryWorkerEnv,
  organizationId: string
): Promise<Response | undefined> => {
  if (!isRoute(request, route, "GET", "workflows", route[1] ?? "")) return
  const workflowId = route[1] ?? ""
  const knownKind = workflowId.startsWith("lint-") || workflowId.startsWith("compiler-")
  const binding = workflowId.startsWith("lint-") ? env.MEMORY_LINT : env.MEMORY_COMPILER
  if (!knownKind || binding === undefined) return
  try {
    const instance = await findWorkflowInstance(binding, env, organizationId, workflowId)
    if (instance === undefined) throw new Error("workflow not found")
    const status = await instance.status()
    // Synthesize a result ONLY when the run has not emitted its own `output` yet.
    // A compiler run persists its proposal set in step 05 and then parks on the
    // review event (`waitForEvent` → platform status "waiting"): only THEN does the
    // deterministic proposal id exist and the run is genuinely awaiting review. A
    // still-queued or actively-compiling run ("queued"/"running") has no proposal
    // id yet, so reporting `pending_review` there makes clients try to review a
    // proposal that does not exist — surface the platform state instead.
    const fallback = workflowId.startsWith("compiler-")
      ? status.status === "waiting"
        ? {
            status: "pending_review",
            workflowId,
            proposalId: `proposal:${workflowId}`,
            proposalIds: []
          }
        : { status: status.status, workflowId }
      : null
    return jsonResponse({ workflowId, state: status.status, result: status.output ?? fallback })
  } catch {
    throw new MemoryVaultError({ code: "not_found", message: `workflow ${workflowId} was not found`, status: 404 })
  }
}

const startCompilerForSource = async (
  source: MemorySource,
  response: Response,
  env: MemoryWorkerEnv,
  organizationId: string
): Promise<string | undefined> => {
  if (!response.ok || env.MEMORY_COMPILER === undefined) return
  const workflowId = `compiler-${stableContentHash(`${organizationId}\u0000${source.id}`)}`
  await createOrReuseScopedWorkflow(env.MEMORY_COMPILER, env, organizationId, workflowId, {
    workflowId,
    organizationId,
    sourceId: source.id,
    requestedBy: "agent:session-capture",
    createdAt: source.retrievedAt ?? new Date().toISOString(),
    autoPublishFixes: configuredMechanicalFixes(env),
    requireReview: false
  })
  return workflowId
}

const signalCompilerReview = async (
  route: ReadonlyArray<string>,
  response: Response,
  env: MemoryWorkerEnv,
  organizationId: string
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
    const instance = await findWorkflowInstance(
      env.MEMORY_COMPILER,
      env,
      organizationId,
      workflowId
    )
    if (instance === undefined) return
    await instance.sendEvent?.({
      type: `review:${proposalId}`,
      payload: { status, proposalId }
    })
  } catch {
    // Publication is durable; an idempotent review retry can re-signal a waiting workflow.
  }
}

/**
 * Whether this vault write advanced the accepted head — a page ingest (201) or an
 * accepted proposal/proposal-set approval (200). A conflicting approval returns
 * 409 (not `ok`) and does NOT advance, so it never triggers reconciliation.
 */
const isAcceptedPublication = (
  request: Request,
  route: ReadonlyArray<string>,
  response: Response
): boolean =>
  response.ok &&
  (isRoute(request, route, "POST", "pages") ||
    isRoute(request, route, "POST", "proposals", "auto-publish") ||
    (route.length === 3 &&
      (route[0] === "proposals" || route[0] === "proposal-sets") &&
      route[2] === "approve"))

/**
 * Best-effort trigger of the durable vector-ingest workflow after an accepted
 * publication. The instance id is deterministic and org-scoped: it hashes the
 * publication's response body (a distinct accepted head → a distinct id), so an
 * idempotent retry of the SAME publication dedupes onto the same instance while a
 * new publication starts a fresh run. Any failure here is swallowed — publication
 * is durable, vector reconciliation is advisory, and the cron drift sweep catches
 * whatever a failed trigger missed.
 */
const triggerVectorIngest = async (
  request: Request,
  route: ReadonlyArray<string>,
  response: Response,
  env: MemoryWorkerEnv,
  organizationId: string
): Promise<void> => {
  if (env.MEMORY_VECTOR_INGEST === undefined || !isAcceptedPublication(request, route, response)) {
    return
  }
  try {
    const marker = stableContentHash(await response.clone().text())
    await createOrReuseScopedWorkflow(
      env.MEMORY_VECTOR_INGEST,
      env,
      organizationId,
      `vector-ingest-${marker}`,
      { organizationId }
    )
  } catch {
    // Publication already committed; advisory vector ingestion is best-effort and
    // the scheduled drift sweep reconciles anything this trigger could not start.
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
  const source =
    isRoute(request, route, "POST", "sources")
      ? (await decodeRequest(request.clone(), SourceRequest)).source
      : undefined
  const response = await env.MEMORY_VAULTS.get(id).fetch(new Request(request, { headers }))
  await signalCompilerReview(route, response, env, organizationId)
  await triggerVectorIngest(request, route, response, env, organizationId)
  const startedWorkflowId =
    source === undefined
      ? undefined
      : await startCompilerForSource(source, response, env, organizationId)
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
  const workflow = await readWorkflow(request, route, env, organizationId)
  return workflow ?? forwardVaultRequest(request, route, env, organizationId)
}

export const handleMemoryWorkerRequest = (
  request: Request,
  env: MemoryWorkerEnv
): Promise<Response> =>
  runRequest(() => dispatchWorkerRequest(request, env))

export class TeamVaultObject extends DurableObject<TeamVaultEnv> {
  private organizationId: string | undefined
  private vault: Promise<TeamVault> | undefined
  private readonly initialized: Promise<void>
  private readonly vaultState: SqliteVaultState

  constructor(
    state: DurableObjectState,
    env: TeamVaultEnv
  ) {
    super(state, env)
    this.vaultEnv = env
    // The real DO storage exposes both `.sql` and the synchronous `transactionSync`
    // the vault's commit path needs; cast through `unknown` because our structural
    // `SqlStorageLike` narrows the binding types Cloudflare's `SqlStorage` accepts.
    this.vaultState = new SqliteVaultState(
      state.storage as unknown as DurableObjectStorageLike
    )
    this.initialized = state.blockConcurrencyWhile(async () => {
      await this.vaultState.initialize()
    })
  }

  private readonly vaultEnv: TeamVaultEnv

  /**
   * Build the advisory vector layer only when BOTH a turbopuffer key and an
   * OpenAI key are configured; otherwise relatedness degrades to lexical-only.
   */
  private vectorLayerFor(organizationId: string): TurbopufferVectorLayer | undefined {
    const client = createTurbopufferClientFromEnv(this.vaultEnv)
    const embedder = createOpenAiEmbedderFromEnv(this.vaultEnv)
    return client === undefined || embedder === undefined
      ? undefined
      : new TurbopufferVectorLayer(client, organizationId, embedder)
  }

  override async fetch(request: Request): Promise<Response> {
    try {
      await this.initialized
      const organizationId = assertVaultOrganization(request.headers.get(VAULT_ORGANIZATION_HEADER))
      if (this.organizationId !== undefined && this.organizationId !== organizationId) {
        return errorResponse(new MemoryAuthenticationError("organization scope mismatch", 403))
      }
      this.organizationId = organizationId
      this.vault ??= Effect.runPromise(
        TeamVault.create(
          organizationId,
          this.vaultState,
          this.vaultEnv.MEMORY_R2,
          this.vectorLayerFor(organizationId)
        )
      )
      return await this.vault.then((vault) => handleTeamVaultRequest(request, vault))
    } catch (error) {
      return errorResponse(error)
    }
  }
}
