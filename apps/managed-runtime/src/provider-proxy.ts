import type { ManagedRuntimeEnv } from "./runtime-env.js"

const ALLOWED_PROVIDER_HOSTS = new Set([
  "github.com",
  "api.github.com",
  "api.openai.com"
])

interface ProviderCredential {
  readonly authorizationHeader: string
}

export interface ProviderProxyDependencies {
  readonly resolve: (
    subject: string,
    capabilityHandle: string
  ) => Promise<ProviderCredential | null>
  readonly fetch: typeof globalThis.fetch
  readonly maxEgressBytes?: number
}

const DEFAULT_MAX_EGRESS_BYTES = 100 * 1024 * 1024

const boundedStream = (
  stream: ReadableStream<Uint8Array> | null,
  maxBytes: number
): ReadableStream<Uint8Array> | null => {
  if (stream === null) return null
  let transferred = 0
  return stream.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      transferred += chunk.byteLength
      if (transferred > maxBytes) {
        controller.error(new Error("Managed provider transfer exceeded its egress limit"))
        return
      }
      controller.enqueue(chunk)
    }
  }))
}

export const resolveProviderCredential = async (
  env: ManagedRuntimeEnv,
  subject: string,
  capabilityHandle: string,
  provider: "github" | "codex" = "github"
): Promise<ProviderCredential | null> => {
  const response = await env.AUTH_STATE.getByName(subject).fetch(
    "https://auth-state.internal/v1/capabilities/resolve",
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-jingler-service-secret": env.MANAGED_RUNTIME_SERVICE_SECRET
      },
      body: JSON.stringify({
        subject,
        provider,
        handle: capabilityHandle,
        audience: "managed-runtime-provider-proxy"
      })
    }
  )
  if (!response.ok) return null
  const body: unknown = await response.json()
  if (
    typeof body !== "object" ||
    body === null ||
    !("authorizationHeader" in body) ||
    typeof body.authorizationHeader !== "string" ||
    !body.authorizationHeader.startsWith("Bearer ")
  ) {
    return null
  }
  return { authorizationHeader: body.authorizationHeader }
}

/** Provider credentials exist only between resolution and the upstream fetch. */
export const proxyProviderRequest = async (
  input: {
    readonly subject: string
    readonly provider?: "github" | "codex"
    readonly capabilityHandle: string
    readonly upstreamUrl: string
    readonly method: "GET" | "POST"
    readonly body?: ReadableStream<Uint8Array> | null
    readonly contentType?: string | null
    readonly accept?: string | null
    readonly contentLength?: number | null
  },
  dependencies: ProviderProxyDependencies
): Promise<Response> => {
  const upstream = new URL(input.upstreamUrl)
  const maxEgressBytes =
    dependencies.maxEgressBytes ?? DEFAULT_MAX_EGRESS_BYTES
  if (upstream.protocol !== "https:" || !ALLOWED_PROVIDER_HOSTS.has(upstream.hostname)) {
    return Response.json({ error: "Provider destination is not allowed" }, { status: 400 })
  }
  if (
    input.contentLength !== null &&
    input.contentLength !== undefined &&
    input.contentLength > maxEgressBytes
  ) {
    return Response.json({ error: "Provider request exceeds its egress limit" }, { status: 413 })
  }
  const credential = await dependencies.resolve(
    input.subject,
    input.capabilityHandle
  )
  if (credential === null) {
    return Response.json({ error: "Provider authorization unavailable" }, { status: 403 })
  }
  const headers = new Headers({
    authorization: credential.authorizationHeader,
    accept:
      input.accept ??
      (input.provider === "codex"
        ? "application/json"
        : "application/vnd.github+json"),
    "user-agent": "Jingler-Managed-Runtime"
  })
  if (input.contentType) headers.set("content-type", input.contentType)
  const requestInit: RequestInit & { duplex?: "half" } = {
    method: input.method,
    headers,
    body: boundedStream(input.body ?? null, maxEgressBytes),
    redirect: "manual"
  }
  if (input.body !== null && input.body !== undefined) requestInit.duplex = "half"
  const upstreamResponse = await dependencies.fetch(new Request(upstream, requestInit))
  const responseLength = Number(upstreamResponse.headers.get("content-length") ?? 0)
  if (Number.isFinite(responseLength) && responseLength > maxEgressBytes) {
    return Response.json({ error: "Provider response exceeds its egress limit" }, { status: 502 })
  }
  const responseHeaders = new Headers(upstreamResponse.headers)
  responseHeaders.delete("set-cookie")
  responseHeaders.delete("location")
  return new Response(boundedStream(upstreamResponse.body, maxEgressBytes), {
    status: upstreamResponse.status,
    headers: responseHeaders
  })
}
