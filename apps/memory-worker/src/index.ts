import { createOrReuseWorkflow, handleMemoryWorkerRequest } from "./api.js"
import type { MemoryWorkerEnv } from "./env.js"
import { stableContentHash } from "@jingler/memory"
import { workflowBindingId } from "./auth.js"

export * from "./env.js"
export * from "./auth.js"
export * from "./r2-store.js"
export * from "./search.js"
export * from "./graph.js"
export * from "./analytics.js"
export * from "./team-vault.js"
export * from "./api.js"
export * from "./compiler-prompt.js"
export * from "./proposals.js"
export * from "./reconciliation.js"
export * from "./workflows/compiler.js"
export * from "./workflows/lint.js"

export { TeamVaultObject } from "./api.js"
export { MemoryCompilerWorkflow } from "./workflows/compiler.js"
export { MemoryLintWorkflow } from "./workflows/lint.js"

interface ScheduledControllerLike {
  readonly scheduledTime: number
}

const scheduledLintOrganizations = (env: MemoryWorkerEnv): ReadonlyArray<string> =>
  [...new Set((env.MEMORY_LINT_ORGANIZATIONS ?? "").split(",").map((value) => value.trim()))]
    .filter((value) => value.length > 0)
    .sort()

export const memoryWorkerHealthResponse = (env: MemoryWorkerEnv): Response =>
  {
    const bindings = {
      durableObjects: env.MEMORY_VAULTS !== undefined,
      r2: env.MEMORY_R2 !== undefined,
      compilerWorkflow: env.MEMORY_COMPILER !== undefined,
      lintWorkflow: env.MEMORY_LINT !== undefined
    }
    const ready = Object.values(bindings).every(Boolean)
    return Response.json(
      {
      status: ready ? "ok" : "degraded",
      service: "@jingler/memory-worker",
      bindings
    },
      { status: ready ? 200 : 503, headers: { "cache-control": "no-store" } }
    )
  }

export default {
  fetch(request: Request, env: MemoryWorkerEnv): Promise<Response> {
    const url = new URL(request.url)
    if (request.method === "GET" && url.pathname === "/health") {
      return Promise.resolve(memoryWorkerHealthResponse(env))
    }
    return handleMemoryWorkerRequest(request, env)
  },
  async scheduled(event: ScheduledControllerLike, env: MemoryWorkerEnv): Promise<void> {
    if (env.MEMORY_LINT === undefined) return
    const asOf = new Date(event.scheduledTime).toISOString()
    const day = asOf.slice(0, 10)
    await Promise.all(
      scheduledLintOrganizations(env).map(async (organizationId) => {
        const workflowId = `lint-${day}-${stableContentHash(organizationId)}`
        const bindingId = await workflowBindingId(
          env.MEMORY_SERVICE_SECRET,
          organizationId,
          workflowId
        )
        await createOrReuseWorkflow(env.MEMORY_LINT!, bindingId, {
          workflowId,
          organizationId,
          asOf
        })
      })
    )
  }
}
