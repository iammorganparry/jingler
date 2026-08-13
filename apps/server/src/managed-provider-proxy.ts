const CHATGPT_CODEX_ORIGIN = "https://chatgpt.com"
const CHATGPT_CODEX_PREFIX = "/backend-api/codex"

export interface ManagedCodexProxyDependencies {
  readonly serviceSecret: string
  readonly maxEgressBytes: number
  readonly fetch?: typeof fetch
}

const allowedHeader = (request: Request, name: string): string | null =>
  request.headers.get(name)

/**
 * Fixed-destination egress for ChatGPT subscription-backed Codex sessions.
 * The managed Worker remains the credential authority; this hop exists because
 * ChatGPT rejects Cloudflare Worker egress before the request reaches Codex.
 */
export const proxyManagedCodexRequest = async (
  request: Request,
  path: string,
  dependencies: ManagedCodexProxyDependencies
): Promise<Response> => {
  if (
    dependencies.serviceSecret.length < 32 ||
    request.headers.get("x-jingler-service-secret") !== dependencies.serviceSecret
  ) {
    return Response.json({ error: "Unauthorized" }, { status: 401 })
  }
  if (request.method !== "GET" && request.method !== "POST") {
    return Response.json({ error: "Method not allowed" }, { status: 405 })
  }
  if (!path.startsWith("/") || path.includes("..") || path.length > 2_048) {
    return Response.json({ error: "Invalid provider path" }, { status: 400 })
  }
  const authorization = request.headers.get("authorization")
  if (authorization === null || !authorization.startsWith("Bearer ")) {
    return Response.json({ error: "Provider authorization unavailable" }, { status: 403 })
  }
  const contentLength = Number(request.headers.get("content-length") ?? 0)
  if (
    !Number.isFinite(contentLength) ||
    contentLength < 0 ||
    contentLength > dependencies.maxEgressBytes
  ) {
    return Response.json({ error: "Provider request exceeds its egress limit" }, { status: 413 })
  }

  const headers = new Headers({ authorization })
  for (const name of [
    "accept",
    "chatgpt-account-id",
    "content-encoding",
    "content-type",
    "openai-beta",
    "originator",
    "session-id",
    "x-client-request-id",
    "user-agent"
  ]) {
    const value = allowedHeader(request, name)
    if (value !== null) headers.set(name, value)
  }
  const target = new URL(`${CHATGPT_CODEX_PREFIX}${path}`, CHATGPT_CODEX_ORIGIN)
  const init: RequestInit & { duplex?: "half" } = {
    method: request.method,
    headers,
    body: request.body,
    redirect: "manual"
  }
  if (request.body !== null) init.duplex = "half"
  const upstream = await (dependencies.fetch ?? fetch)(target, init)
  const responseLength = Number(upstream.headers.get("content-length") ?? 0)
  if (Number.isFinite(responseLength) && responseLength > dependencies.maxEgressBytes) {
    return Response.json({ error: "Provider response exceeds its egress limit" }, { status: 502 })
  }
  const responseHeaders = new Headers(upstream.headers)
  responseHeaders.delete("location")
  responseHeaders.delete("set-cookie")
  return new Response(upstream.body, {
    status: upstream.status,
    headers: responseHeaders
  })
}
