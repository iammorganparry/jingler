import { env } from "../../../../src/env.js"

export const dynamic = "force-dynamic"

interface MemoryHealthDependencies {
  readonly enabled: boolean
  readonly workerUrl: string
  readonly timeoutMs: number
  readonly fetch: typeof fetch
}

export const checkMemoryHealth = async (
  dependencies: MemoryHealthDependencies
): Promise<Response> => {
  if (!dependencies.enabled) {
    return Response.json(
      { status: "disabled", service: "jingler-memory" },
      { headers: { "cache-control": "no-store" } }
    )
  }
  try {
    const response = await dependencies.fetch(
      new URL("/health", dependencies.workerUrl),
      { signal: AbortSignal.timeout(dependencies.timeoutMs) }
    )
    if (!response.ok) throw new Error(`Worker health returned ${response.status}`)
    return Response.json(
      { status: "ok", service: "jingler-memory", upstream: "ok" },
      { headers: { "cache-control": "no-store" } }
    )
  } catch {
    return Response.json(
      { status: "degraded", service: "jingler-memory", upstream: "unavailable" },
      { status: 503, headers: { "cache-control": "no-store" } }
    )
  }
}

export const GET = (): Promise<Response> =>
  checkMemoryHealth({
    enabled: env.memoryEnabled,
    workerUrl: env.memoryWorkerUrl,
    timeoutMs: env.memoryRequestTimeoutMs,
    fetch
  })
