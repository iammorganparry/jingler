import type { ManagedRuntimeEnv } from "./runtime-env.js"

const ALLOWED_PROVIDER_HOSTS = new Set([
  "github.com",
  "api.github.com",
  "api.openai.com",
  "chatgpt.com",
  "api.anthropic.com"
])

interface ProviderCredential {
  readonly authorizationHeader: string
  readonly upstream?: "github-api" | "openai-api" | "chatgpt-codex" | "anthropic-api"
  readonly accountId?: string
}

export interface ProviderAuthorizationScope {
  readonly subject: string
  readonly capabilityHandle: string
}

export const providerAuthorizationScope = (
  value: unknown
): ProviderAuthorizationScope | null => {
  if (typeof value !== "object" || value === null) return null
  const fields = Object.fromEntries(Object.entries(value))
  return typeof fields.subject === "string" &&
    typeof fields.capabilityHandle === "string"
    ? { subject: fields.subject, capabilityHandle: fields.capabilityHandle }
    : null
}

export interface ProviderProxyDependencies {
  readonly resolve: (
    subject: string,
    capabilityHandle: string
  ) => Promise<ProviderCredential | null>
  readonly fetch: typeof globalThis.fetch
  readonly maxEgressBytes?: number
}

export interface ControlPlaneProviderFetchDependencies {
  readonly controlPlaneUrl: string
  readonly serviceSecret: string
  readonly fetch: typeof globalThis.fetch
}

/** Route only ChatGPT subscription traffic away from Cloudflare's blocked egress range. */
export const createControlPlaneProviderFetch = (
  dependencies: ControlPlaneProviderFetchDependencies
): typeof globalThis.fetch => async (input, init) => {
  const request = input instanceof Request ? input : new Request(input, init)
  const upstream = new URL(request.url)
  if (
    upstream.origin !== "https://chatgpt.com" ||
    !upstream.pathname.startsWith("/backend-api/codex/")
  ) {
    return Reflect.apply(dependencies.fetch, globalThis, [request])
  }
  const path = upstream.pathname.slice("/backend-api/codex".length)
  const target = new URL(
    `/api/internal/managed-provider/codex${path}${upstream.search}`,
    dependencies.controlPlaneUrl
  )
  const headers = new Headers(request.headers)
  headers.set("x-jingler-service-secret", dependencies.serviceSecret)
  const requestInit: RequestInit & { duplex?: "half" } = {
    method: request.method,
    headers,
    body: request.body,
    redirect: "manual"
  }
  if (request.body !== null) requestInit.duplex = "half"
  return Reflect.apply(dependencies.fetch, globalThis, [new Request(target, requestInit)])
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
  provider: "github" | "codex" | "claude" = "github"
): Promise<ProviderCredential | null> => {
  const response = await env.AUTH_STATE.getByName(subject).fetch(
    "https://auth-state.internal/v1/capabilities/resolve",
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-jingler-service-secret": env.AUTH_STATE_SERVICE_SECRET
      },
      body: JSON.stringify({
        subject,
        provider,
        handle: capabilityHandle,
        audience: "managed-runtime-provider-proxy"
      })
    }
  )
  if (!response.ok) {
    console.warn(JSON.stringify({
      component: "managed-provider-proxy",
      event: "capability_resolution_denied",
      provider,
      status: response.status
    }))
    return null
  }
  const body: unknown = await response.json()
  if (
    typeof body !== "object" ||
    body === null ||
    !("authorizationHeader" in body) ||
    typeof body.authorizationHeader !== "string" ||
    !(body.authorizationHeader.startsWith("Bearer ") ||
      body.authorizationHeader.startsWith("X-Api-Key "))
  ) {
    return null
  }
  const upstream = "upstream" in body && typeof body.upstream === "string"
    ? body.upstream
    : undefined
  const accountId = "accountId" in body && typeof body.accountId === "string"
    ? body.accountId
    : undefined
  if (
    upstream !== undefined &&
    upstream !== "github-api" &&
    upstream !== "openai-api" &&
    upstream !== "chatgpt-codex" &&
    upstream !== "anthropic-api"
  ) {
    return null
  }
  return { authorizationHeader: body.authorizationHeader, upstream, accountId }
}

/** Provider credentials exist only between resolution and the upstream fetch. */
export const proxyProviderRequest = async (
  input: {
    readonly subject: string
    readonly provider?: "github" | "codex" | "claude"
    readonly gitSmartHttp?: boolean
    readonly capabilityHandle: string
    readonly upstreamUrl: string
    readonly method: "GET" | "POST"
    readonly body?: ReadableStream<Uint8Array> | null
    readonly contentType?: string | null
    readonly accept?: string | null
    readonly userAgent?: string | null
    readonly originator?: string | null
    readonly openAiBeta?: string | null
    readonly anthropicBeta?: string | null
    readonly contentLength?: number | null
  },
  dependencies: ProviderProxyDependencies
): Promise<Response> => {
  let upstream = new URL(input.upstreamUrl)
  const configuredLimit = dependencies.maxEgressBytes
  const maxEgressBytes =
    configuredLimit !== undefined &&
    Number.isSafeInteger(configuredLimit) &&
    configuredLimit > 0
      ? configuredLimit
      : DEFAULT_MAX_EGRESS_BYTES
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
  if (input.provider === "codex" && credential.upstream === "chatgpt-codex") {
    const path = upstream.pathname.replace(/^\/v1(?=\/|$)/u, "")
    upstream = new URL(`https://chatgpt.com/backend-api/codex${path}${upstream.search}`)
  }
  const expectedUpstream = input.provider === "claude"
    ? "anthropic-api"
    : input.provider === "codex"
      ? (credential.upstream ?? "openai-api")
      : "github-api"
  const validDestination =
    (expectedUpstream === "github-api" &&
      (upstream.hostname === "github.com" || upstream.hostname === "api.github.com")) ||
    (expectedUpstream === "openai-api" && upstream.hostname === "api.openai.com") ||
    (expectedUpstream === "chatgpt-codex" && upstream.hostname === "chatgpt.com") ||
    (expectedUpstream === "anthropic-api" && upstream.hostname === "api.anthropic.com")
  if (!validDestination) {
    return Response.json({ error: "Provider capability destination mismatch" }, { status: 403 })
  }
  const headers = new Headers({
    accept:
      input.accept ??
      (input.provider === "codex"
        ? "application/json"
        : input.provider === "claude"
          ? "application/json"
        : "application/vnd.github+json"),
    "user-agent": input.userAgent ?? "Jingler-Managed-Runtime"
  })
  if (
    input.provider === "github" &&
    input.gitSmartHttp === true &&
    credential.authorizationHeader.startsWith("Bearer ")
  ) {
    const token = credential.authorizationHeader.slice("Bearer ".length)
    headers.set("authorization", `Basic ${btoa(`x-access-token:${token}`)}`)
  } else if (credential.authorizationHeader.startsWith("X-Api-Key ")) {
    headers.set("x-api-key", credential.authorizationHeader.slice("X-Api-Key ".length))
  } else {
    headers.set("authorization", credential.authorizationHeader)
  }
  if (expectedUpstream === "chatgpt-codex" && credential.accountId) {
    headers.set("chatgpt-account-id", credential.accountId)
  }
  if (input.provider === "codex") {
    if (input.originator) headers.set("originator", input.originator)
    if (input.openAiBeta) headers.set("openai-beta", input.openAiBeta)
  }
  if (input.provider === "claude") {
    headers.set("anthropic-version", "2023-06-01")
    if (input.anthropicBeta) headers.set("anthropic-beta", input.anthropicBeta)
  }
  if (input.contentType) headers.set("content-type", input.contentType)
  const requestInit: RequestInit & { duplex?: "half" } = {
    method: input.method,
    headers,
    body: boundedStream(input.body ?? null, maxEgressBytes),
    redirect: "manual"
  }
  if (input.body !== null && input.body !== undefined) requestInit.duplex = "half"
  const upstreamResponse = await Reflect.apply(dependencies.fetch, globalThis, [
    new Request(upstream, requestInit)
  ])
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
