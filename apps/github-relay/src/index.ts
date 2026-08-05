import { bearerGrant, verifyRelayGrant } from "./auth.js"
import { RELAY_POLICY } from "./env.js"
import {
  normalizeGitHubWebhook,
  readBoundedWebhookBody,
  verifyGitHubWebhookSignature,
  WebhookBodyTooLargeError
} from "./github-webhook.js"

export { bearerGrant, verifyRelayGrant } from "./auth.js"
export { RELAY_POLICY } from "./env.js"
export * from "./github-webhook.js"
export { InstallationRoutesObject, UserEventsObject } from "./user-events.js"

const noStoreHeaders = { "cache-control": "no-store" } as const
const encoder = new TextEncoder()

const json = (body: unknown, status = 200): Response =>
  Response.json(body, { status, headers: noStoreHeaders })

const installationIdFromPayload = (payload: unknown): string | null => {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null
  const installation = (payload as Record<string, unknown>).installation
  if (!installation || typeof installation !== "object" || Array.isArray(installation)) return null
  const id = (installation as Record<string, unknown>).id
  return typeof id === "number" && Number.isSafeInteger(id)
    ? String(id)
    : typeof id === "string" && /^\d+$/.test(id)
      ? id
      : null
}

const verifyInternalRequest = async (
  body: ArrayBuffer,
  request: Request,
  secret: string
): Promise<boolean> => {
  const timestamp = request.headers.get("x-jingler-timestamp")
  const signature = request.headers.get("x-jingler-signature")
  if (!timestamp || !/^\d+$/.test(timestamp) || !signature?.startsWith("sha256=")) return false
  const seconds = Number(timestamp)
  if (!Number.isSafeInteger(seconds) || Math.abs(Date.now() / 1_000 - seconds) > 60) return false
  const expected = signature.slice("sha256=".length)
  if (!/^[a-f0-9]{64}$/i.test(expected)) return false
  const signatureBytes = new Uint8Array(32)
  for (let index = 0; index < expected.length; index += 2) {
    signatureBytes[index / 2] = Number.parseInt(expected.slice(index, index + 2), 16)
  }
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"]
  )
  const payload = new Uint8Array(body)
  const signed = new Uint8Array(encoder.encode(`${timestamp}.`).length + payload.length)
  signed.set(encoder.encode(`${timestamp}.`))
  signed.set(payload, encoder.encode(`${timestamp}.`).length)
  return crypto.subtle.verify("HMAC", key, signatureBytes, signed)
}

const handleWebhook = async (request: Request, env: Env): Promise<Response> => {
  const deliveryId = request.headers.get("x-github-delivery")?.trim()
  const eventName = request.headers.get("x-github-event")?.trim()
  if (!deliveryId || !/^[a-zA-Z0-9-]{1,128}$/.test(deliveryId) || !eventName) {
    return json({ error: "Missing GitHub delivery headers" }, 400)
  }
  let body: ArrayBuffer
  try {
    body = await readBoundedWebhookBody(request)
  } catch (error) {
    if (error instanceof WebhookBodyTooLargeError) {
      return json({ error: "Webhook payload too large" }, 413)
    }
    throw error
  }
  if (
    !(await verifyGitHubWebhookSignature(
      body,
      request.headers.get("x-hub-signature-256"),
      env.GITHUB_WEBHOOK_SECRET
    ))
  ) {
    return json({ error: "Invalid webhook signature" }, 401)
  }
  let payload: unknown
  try {
    payload = JSON.parse(new TextDecoder().decode(body))
  } catch {
    return json({ error: "Invalid webhook payload" }, 400)
  }
  if (eventName === "ping") return json({ accepted: true, pong: true })
  if (eventName === "installation") {
    const action =
      payload && typeof payload === "object" && !Array.isArray(payload)
        ? (payload as Record<string, unknown>).action
        : null
    const installationId = installationIdFromPayload(payload)
    if (installationId && (action === "deleted" || action === "suspend")) {
      const revokedUsers = await env.INSTALLATION_ROUTES.getByName(installationId).revokeAll(
        installationId
      )
      return json({ accepted: true, lifecycle: action, revokedUsers })
    }
    return json({ accepted: true, ignored: true }, 202)
  }
  const event = await normalizeGitHubWebhook({ deliveryId, eventName, payload })
  if (!event) return json({ accepted: true, ignored: true }, 202)
  const result = await env.INSTALLATION_ROUTES.getByName(event.installationId).dispatch(event)
  return json({ accepted: true, duplicate: result.duplicate, routedUsers: result.routedUsers })
}

const handleEvents = async (request: Request, env: Env): Promise<Response> => {
  if (request.headers.get("upgrade")?.toLocaleLowerCase("en-US") !== "websocket") {
    return json({ error: "Expected websocket upgrade" }, 426)
  }
  const grant = bearerGrant(request)
  const claims = grant
    ? await verifyRelayGrant(grant, env.GITHUB_RELAY_SIGNING_SECRET)
    : null
  if (!claims) return json({ error: "Invalid relay grant" }, 401)
  const url = new URL(request.url)
  const clientId = url.searchParams.get("clientId")
  const cursor = url.searchParams.get("cursor") ?? "0"
  if (!clientId || !/^[a-zA-Z0-9._:-]{1,128}$/.test(clientId) || !/^\d+$/.test(cursor)) {
    return json({ error: "Invalid relay cursor or client id" }, 400)
  }
  const scopedClientId = `${claims.installationId}:${clientId}`
  if (scopedClientId.length > 128) return json({ error: "Invalid relay client id" }, 400)

  const subscriptionExpiry = Math.min(
    claims.expiresAt * 1_000,
    Date.now() + RELAY_POLICY.subscriptionRetentionMs
  )
  await env.INSTALLATION_ROUTES.getByName(claims.installationId).subscribe(
    claims.subject,
    subscriptionExpiry
  )
  const headers = new Headers({
    Upgrade: "websocket",
    "x-jingler-client-id": scopedClientId,
    "x-jingler-cursor": cursor,
    "x-jingler-installation-id": claims.installationId,
    "x-jingler-expires-at": String(claims.expiresAt * 1_000)
  })
  return env.USER_EVENTS.getByName(claims.subject).fetch(
    new Request("https://relay.internal/events", { headers })
  )
}

const handleInternalRevoke = async (request: Request, env: Env): Promise<Response> => {
  const body = await request.arrayBuffer()
  if (body.byteLength > 64 * 1_024) return json({ error: "Payload too large" }, 413)
  if (!(await verifyInternalRequest(body, request, env.GITHUB_RELAY_SIGNING_SECRET))) {
    return json({ error: "Invalid internal signature" }, 401)
  }
  let payload: unknown
  try {
    payload = JSON.parse(new TextDecoder().decode(body))
  } catch {
    return json({ error: "Invalid payload" }, 400)
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return json({ error: "Invalid payload" }, 400)
  }
  const record = payload as Record<string, unknown>
  const userId = typeof record.userId === "string" ? record.userId : ""
  const installationId =
    typeof record.installationId === "string" && /^\d+$/.test(record.installationId)
      ? record.installationId
      : ""
  if (!userId || userId.length > 256 || !installationId) {
    return json({ error: "Invalid revocation target" }, 400)
  }
  await env.INSTALLATION_ROUTES.getByName(installationId).unsubscribe(userId)
  const closedSockets = await env.USER_EVENTS.getByName(userId).revokeInstallation(installationId)
  return json({ revoked: true, closedSockets })
}

const health = (env: Env): Response => {
  const bindings = {
    userEvents: env.USER_EVENTS !== undefined,
    installationRoutes: env.INSTALLATION_ROUTES !== undefined,
    webhookSecret: env.GITHUB_WEBHOOK_SECRET?.length > 0,
    relaySigningSecret: env.GITHUB_RELAY_SIGNING_SECRET?.length > 0
  }
  const ready = Object.values(bindings).every(Boolean)
  return json({ status: ready ? "ok" : "degraded", service: "@jingler/github-relay", bindings }, ready ? 200 : 503)
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url)
    try {
      if (request.method === "GET" && url.pathname === "/health") return health(env)
      if (request.method === "POST" && url.pathname === "/webhooks/github") {
        return await handleWebhook(request, env)
      }
      if (request.method === "GET" && url.pathname === "/events") {
        return await handleEvents(request, env)
      }
      if (request.method === "POST" && url.pathname === "/internal/revoke") {
        return await handleInternalRevoke(request, env)
      }
      return json({ error: "Not found" }, 404)
    } catch (error) {
      console.error(
        JSON.stringify({
          level: "error",
          message: "GitHub relay request failed",
          method: request.method,
          path: url.pathname,
          error: error instanceof Error ? error.name : "UnknownError"
        })
      )
      return json({ error: "Relay unavailable" }, 503)
    }
  }
} satisfies ExportedHandler<Env>
