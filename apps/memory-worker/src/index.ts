import { createOrReuseScopedWorkflow, handleMemoryWorkerRequest } from "./api.js"
import type { MemoryWorkerEnv } from "./env.js"
import { stableContentHash } from "@jingler/memory"
import { listOrganizationIds } from "./r2-store.js"

export * from "./env.js"
export * from "./auth.js"
export * from "./r2-store.js"
export * from "./search.js"
export * from "./graph.js"
export * from "./embeddings.js"
export * from "./turbopuffer.js"
export * from "./suggestions.js"
export * from "./analytics.js"
export * from "./team-vault.js"
export * from "./api.js"
export * from "./compiler-prompt.js"
export * from "./proposals.js"
export * from "./reconciliation.js"
export * from "./workflows/compiler.js"
export * from "./workflows/lint.js"
export * from "./workflows/vector-ingest.js"

export { TeamVaultObject } from "./api.js"
export { MemoryCompilerWorkflow } from "./workflows/compiler.js"
export { MemoryLintWorkflow } from "./workflows/lint.js"
export { MemoryVectorIngestWorkflow } from "./workflows/vector-ingest.js"

interface ScheduledControllerLike {
  readonly scheduledTime: number
}

const parseOrganizationList = (value: string | undefined): ReadonlyArray<string> =>
  [...new Set((value ?? "").split(",").map((entry) => entry.trim()))]
    .filter((entry) => entry.length > 0)
    .sort()

const scheduledMaintenanceOrganizations = (env: MemoryWorkerEnv): ReadonlyArray<string> =>
  parseOrganizationList(env.MEMORY_LINT_ORGANIZATIONS)

/**
 * The org set the daily vector drift sweep reconciles. It is the UNION of every org
 * with an R2 vault (discovered by listing org prefixes), the lint allow-list, and an
 * optional explicit `MEMORY_VECTOR_ORGANIZATIONS` override — so an org that never
 * opted into lint still gets its advisory turbopuffer namespace reconciled after a
 * missed publication trigger, instead of drifting stale forever.
 */
const scheduledVectorOrganizations = async (env: MemoryWorkerEnv): Promise<ReadonlyArray<string>> => {
  const configured = new Set<string>([
    ...scheduledMaintenanceOrganizations(env),
    ...parseOrganizationList(env.MEMORY_VECTOR_ORGANIZATIONS)
  ])
  if (env.MEMORY_R2 !== undefined) {
    for (const organizationId of await listOrganizationIds(env.MEMORY_R2)) {
      configured.add(organizationId)
    }
  }
  return [...configured].sort()
}

const sweepScheduledLint = async (
  env: MemoryWorkerEnv,
  organizations: ReadonlyArray<string>,
  asOf: string,
  day: string
): Promise<void> => {
  if (env.MEMORY_LINT === undefined) return
  await Promise.all(
    organizations.map(async (organizationId) => {
      const workflowId = `lint-${day}-${stableContentHash(organizationId)}`
      await createOrReuseScopedWorkflow(
        env.MEMORY_LINT!,
        env,
        organizationId,
        workflowId,
        { workflowId, organizationId, asOf }
      )
    })
  )
}

// Drift sweep for the advisory vector namespaces: publication triggers keep them
// fresh, and this daily pass reconciles anything a best-effort trigger missed.
const sweepVectorIngest = async (
  env: MemoryWorkerEnv,
  organizations: ReadonlyArray<string>,
  day: string
): Promise<void> => {
  if (env.MEMORY_VECTOR_INGEST === undefined) return
  await Promise.all(
    organizations.map(async (organizationId) => {
      const workflowId = `vector-ingest-sweep-${day}-${stableContentHash(organizationId)}`
      await createOrReuseScopedWorkflow(
        env.MEMORY_VECTOR_INGEST!,
        env,
        organizationId,
        workflowId,
        { organizationId }
      )
    })
  )
}

const RETIRED_REVIEW_GATE_WARNING =
  "MEMORY_REQUIRE_REVIEW is retired and ignored; remove it because agent memory publication is automatic."

const deprecatedConfigurationWarnings = (
  env: MemoryWorkerEnv
): ReadonlyArray<string> =>
  env.MEMORY_REQUIRE_REVIEW === undefined ? [] : [RETIRED_REVIEW_GATE_WARNING]

let didWarnAboutRetiredReviewGate = false

const warnAboutDeprecatedConfiguration = (env: MemoryWorkerEnv): void => {
  if (didWarnAboutRetiredReviewGate) return
  const warnings = deprecatedConfigurationWarnings(env)
  if (warnings.length === 0) return
  didWarnAboutRetiredReviewGate = true
  for (const warning of warnings) console.warn(warning)
}

export const memoryWorkerHealthResponse = (env: MemoryWorkerEnv): Response =>
  {
    const bindings = {
      durableObjects: env.MEMORY_VAULTS !== undefined,
      r2: env.MEMORY_R2 !== undefined,
      compilerWorkflow: env.MEMORY_COMPILER !== undefined,
      lintWorkflow: env.MEMORY_LINT !== undefined
    }
    const ready = Object.values(bindings).every(Boolean)
    const warnings = deprecatedConfigurationWarnings(env)
    return Response.json(
      {
      status: ready ? "ok" : "degraded",
      service: "@jingler/memory-worker",
      bindings,
      ...(warnings.length === 0 ? {} : { warnings })
    },
      { status: ready ? 200 : 503, headers: { "cache-control": "no-store" } }
    )
  }

export default {
  fetch(request: Request, env: MemoryWorkerEnv): Promise<Response> {
    warnAboutDeprecatedConfiguration(env)
    const url = new URL(request.url)
    if (request.method === "GET" && url.pathname === "/health") {
      return Promise.resolve(memoryWorkerHealthResponse(env))
    }
    return handleMemoryWorkerRequest(request, env)
  },
  async scheduled(event: ScheduledControllerLike, env: MemoryWorkerEnv): Promise<void> {
    warnAboutDeprecatedConfiguration(env)
    const asOf = new Date(event.scheduledTime).toISOString()
    const day = asOf.slice(0, 10)
    const [lintOrganizations, vectorOrganizations] = await Promise.all([
      Promise.resolve(scheduledMaintenanceOrganizations(env)),
      scheduledVectorOrganizations(env)
    ])
    await Promise.all([
      sweepScheduledLint(env, lintOrganizations, asOf, day),
      sweepVectorIngest(env, vectorOrganizations, day)
    ])
  }
}
