import { env } from "../../../../src/env.js"
import { checkMemoryHealth } from "../../../../src/memory-health.js"

export const dynamic = "force-dynamic"

export const GET = (): Promise<Response> =>
  checkMemoryHealth({
    enabled: env.memoryEnabled,
    workerUrl: env.memoryWorkerUrl,
    timeoutMs: env.memoryRequestTimeoutMs,
    fetch
  })
