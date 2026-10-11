/**
 * Team-memory health probe. Kept OUT of the Next.js route module because Next 16
 * rejects value exports from a `route.ts` that are not route handlers — the route
 * file may only re-export `dynamic` + `GET`.
 */
export interface MemoryHealthDependencies {
  readonly enabled: boolean;
  readonly workerUrl: string;
  readonly timeoutMs: number;
  readonly fetch: typeof fetch;
}

const rolloutReadiness = (value: unknown): unknown => {
  if (typeof value !== "object" || value === null) return null;
  const configuration = Reflect.get(value, "configuration");
  if (typeof configuration !== "object" || configuration === null) return null;
  const rollout = Reflect.get(configuration, "rollout");
  if (typeof rollout !== "object" || rollout === null) return null;
  const revision = Reflect.get(rollout, "revision");
  const automaticStops = Reflect.get(rollout, "automaticStops");
  const reflectionBasisPoints = Reflect.get(rollout, "reflectionBasisPoints");
  const extractionBasisPoints = Reflect.get(rollout, "extractionBasisPoints");
  const autoPublicationBasisPoints = Reflect.get(
    rollout,
    "autoPublicationBasisPoints",
  );
  return typeof revision === "string" &&
    automaticStops === true &&
    typeof reflectionBasisPoints === "number" &&
    typeof extractionBasisPoints === "number" &&
    typeof autoPublicationBasisPoints === "number"
    ? {
        revision,
        automaticStops,
        reflectionBasisPoints,
        extractionBasisPoints,
        autoPublicationBasisPoints,
      }
    : null;
};

export const checkMemoryHealth = async (
  dependencies: MemoryHealthDependencies,
): Promise<Response> => {
  if (!dependencies.enabled) {
    return Response.json(
      { status: "disabled", service: "jingler-memory" },
      { headers: { "cache-control": "no-store" } },
    );
  }
  try {
    const response = await dependencies.fetch(
      new URL("/health", dependencies.workerUrl),
      { signal: AbortSignal.timeout(dependencies.timeoutMs) },
    );
    if (!response.ok)
      throw new Error(`Worker health returned ${response.status}`);
    const upstream = await response.json().catch(() => null);
    return Response.json(
      {
        status: "ok",
        service: "jingler-memory",
        upstream: "ok",
        rollout: rolloutReadiness(upstream),
      },
      { headers: { "cache-control": "no-store" } },
    );
  } catch {
    return Response.json(
      {
        status: "degraded",
        service: "jingler-memory",
        upstream: "unavailable",
      },
      { status: 503, headers: { "cache-control": "no-store" } },
    );
  }
};
