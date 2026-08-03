/**
 * Team-memory health probe. Kept OUT of the Next.js route module because Next 16
 * rejects value exports from a `route.ts` that are not route handlers — the route
 * file may only re-export `dynamic` + `GET`.
 */
export interface MemoryHealthDependencies {
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
