import { bearerGrant, verifyRelayGrant } from "./auth.js"
import { RELAY_POLICY, relayTelemetry } from "./env.js"
import {
  normalizeGitHubWebhook,
  readBoundedWebhookBody,
  verifyGitHubWebhookSignature,
  WebhookBodyTooLargeError
} from "./github-webhook.js"
import type {
  InstallationState,
  SessionRouteMutation,
  SessionRouteState
} from "./installation-routes.js"
import type { RelayRegistrationParams } from "./workflows/relay-registration.js"

export { bearerGrant, verifyRelayGrant } from "./auth.js"
export { RELAY_POLICY } from "./env.js"
export * from "./github-webhook.js"
export { InstallationRoutesObject } from "./installation-routes.js"
export { SessionEventsObject } from "./session-events.js"
export { GitHubDeliveryWorkflow } from "./workflows/github-delivery.js"
export { RelayRegistrationWorkflow } from "./workflows/relay-registration.js"

const noStoreHeaders = { "cache-control": "no-store" } as const
const encoder = new TextEncoder()

const json = (body: unknown, status = 200): Response =>
  Response.json(body, { status, headers: noStoreHeaders })

const record = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null

const installationIdFromPayload = (payload: unknown): string | null => {
  const installation = record(record(payload)?.installation)
  const id = installation?.id
  return typeof id === "number" && Number.isSafeInteger(id)
    ? String(id)
    : typeof id === "string" && /^\d+$/.test(id)
      ? id
      : null
}

const installationGenerationFromPayload = (payload: unknown): number | null => {
  const updatedAt = record(record(payload)?.installation)?.updated_at
  if (typeof updatedAt !== "string") return null
  const generation = Date.parse(updatedAt)
  return Number.isSafeInteger(generation) && generation >= 0 ? generation : null
}

const workflowId = async (prefix: string, externalId: string): Promise<string> => {
  const bytes = await crypto.subtle.digest("SHA-256", encoder.encode(externalId))
  const digest = [...new Uint8Array(bytes)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")
  return `${prefix}-${digest}`
}

const createOnce = async <T>(
  workflow: Workflow<T>,
  id: string,
  params: T
): Promise<{ readonly id: string; readonly duplicate: boolean }> => {
  try {
    const instances = await workflow.createBatch([{ id, params }])
    return { id, duplicate: instances.length === 0 }
  } catch (creationError) {
    try {
      await workflow.get(id)
      return { id, duplicate: true }
    } catch {
      throw creationError
    }
  }
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
  const prefix = encoder.encode(`${timestamp}.`)
  const signed = new Uint8Array(prefix.length + payload.length)
  signed.set(prefix)
  signed.set(payload, prefix.length)
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
    relayTelemetry("invalid_signature", { source: "github" })
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
    const action = record(payload)?.action
    const installationId = installationIdFromPayload(payload)
    const generation = installationGenerationFromPayload(payload)
    if (
      installationId &&
      generation !== null &&
      (action === "deleted" || action === "suspend" || action === "unsuspend")
    ) {
      const state: InstallationState =
        action === "deleted" ? "removed" : action === "suspend" ? "suspended" : "active"
      const id = await workflowId("lifecycle", deliveryId)
      const created = await createOnce(env.RELAY_REGISTRATION_WORKFLOW, id, {
        kind: "installation-lifecycle",
        mutationId: deliveryId,
        generation,
        installationId,
        state
      })
      return json({ accepted: true, lifecycle: action, workflowId: id, duplicate: created.duplicate }, 202)
    }
    return json({ accepted: true, ignored: true }, 202)
  }

  const event = await normalizeGitHubWebhook({
    deliveryId,
    eventName,
    payload,
    ourAppId: env.GITHUB_APP_ID
  })
  if (!event) return json({ accepted: true, ignored: true }, 202)
  if (!event.pullRequest) {
    relayTelemetry("ignored_event", {
      installationId: event.installationId,
      event: event.event,
      reason: "no_pull_request_route"
    })
    return json({ accepted: true, ignored: true, reason: "no_pull_request_route" }, 202)
  }
  const id = await workflowId("delivery", deliveryId)
  const routes = env.INSTALLATION_ROUTES.getByName(event.installationId)
  const admission = await routes.prepareDeliveryWorkflow(deliveryId, id)
  let workflowDuplicate = false
  if (admission.shouldCreate) {
    const created = await createOnce(env.GITHUB_DELIVERY_WORKFLOW, admission.workflowId, event)
    workflowDuplicate = created.duplicate
    await routes.confirmDeliveryWorkflow(deliveryId)
  }
  const duplicate = admission.duplicate || workflowDuplicate
  relayTelemetry(duplicate ? "delivery_deduplicated" : "workflow_created", {
    installationId: event.installationId,
    workflowId: admission.workflowId
  })
  return json(
    { accepted: true, workflowId: admission.workflowId, duplicate },
    202
  )
}

const handleEvents = async (request: Request, env: Env): Promise<Response> => {
  if (request.headers.get("upgrade")?.toLocaleLowerCase("en-US") !== "websocket") {
    return json({ error: "Expected websocket upgrade" }, 426)
  }
  const grant = bearerGrant(request)
  const claims = grant ? await verifyRelayGrant(grant, env.GITHUB_RELAY_SIGNING_SECRET) : null
  if (!claims) return json({ error: "Invalid relay grant" }, 401)
  const url = new URL(request.url)
  const clientId = url.searchParams.get("clientId")
  const cursor = url.searchParams.get("cursor") ?? "0"
  if (!clientId || !/^[a-zA-Z0-9._:-]{1,128}$/.test(clientId) || !/^\d+$/.test(cursor)) {
    return json({ error: "Invalid relay cursor or client id" }, 400)
  }
  if (
    !(await env.INSTALLATION_ROUTES.getByName(claims.installationId).ownsSession(
      claims.subject,
      claims.relaySessionId
    ))
  ) {
    relayTelemetry("socket_authorization_rejected", { installationId: claims.installationId })
    return json({ error: "Session route is not registered" }, 403)
  }
  const headers = new Headers({
    Upgrade: "websocket",
    "x-jingler-client-id": clientId,
    "x-jingler-cursor": cursor,
    "x-jingler-expires-at": String(claims.expiresAt * 1_000)
  })
  return env.SESSION_EVENTS.getByName(claims.relaySessionId).fetch(
    new Request("https://relay.internal/events", { headers })
  )
}

const readInternalPayload = async (
  request: Request,
  env: Env
): Promise<{ readonly body: Record<string, unknown> } | Response> => {
  const body = await request.arrayBuffer()
  if (body.byteLength > 64 * 1_024) return json({ error: "Payload too large" }, 413)
  if (!(await verifyInternalRequest(body, request, env.GITHUB_RELAY_SIGNING_SECRET))) {
    relayTelemetry("invalid_signature", { source: "server" })
    return json({ error: "Invalid internal signature" }, 401)
  }
  try {
    const payload = record(JSON.parse(new TextDecoder().decode(body)))
    return payload ? { body: payload } : json({ error: "Invalid payload" }, 400)
  } catch {
    return json({ error: "Invalid payload" }, 400)
  }
}

const validMutationId = (value: unknown): value is string =>
  typeof value === "string" && /^[a-zA-Z0-9:_-]{1,128}$/.test(value)
const validInstallationId = (value: unknown): value is string =>
  typeof value === "string" && /^\d+$/.test(value)
const validRelaySessionId = (value: unknown): value is string =>
  typeof value === "string" && /^[a-zA-Z0-9_-]{16,128}$/.test(value)
const validGeneration = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0

const startRegistration = async (
  env: Env,
  mutationId: string,
  params: RelayRegistrationParams
): Promise<Response> => {
  const id = await workflowId("registration", mutationId)
  const created = await createOnce(env.RELAY_REGISTRATION_WORKFLOW, id, params)
  return json({ accepted: true, mutationId, workflowId: id, duplicate: created.duplicate }, 202)
}

const handleInternalInstallation = async (
  request: Request,
  env: Env,
  legacyRevoke = false
): Promise<Response> => {
  const parsed = await readInternalPayload(request, env)
  if (parsed instanceof Response) return parsed
  const value = parsed.body
  const mutationId = legacyRevoke ? `legacy:${String(value.userId)}` : value.mutationId
  const state: InstallationState | null = legacyRevoke
    ? "removed"
    : value.state === "active" || value.state === "suspended" || value.state === "removed"
      ? value.state
      : null
  if (
    !validMutationId(mutationId) ||
    !validGeneration(value.generation) ||
    !validInstallationId(value.installationId) ||
    typeof value.userId !== "string" ||
    value.userId.length === 0 ||
    value.userId.length > 256 ||
    !state
  ) {
    return json({ error: "Invalid installation registration" }, 400)
  }
  return startRegistration(env, mutationId, {
    kind: "installation-owner",
    mutationId,
    generation: value.generation,
    installationId: value.installationId,
    userId: value.userId,
    state
  })
}

const handleInternalSessionRoute = async (request: Request, env: Env): Promise<Response> => {
  const parsed = await readInternalPayload(request, env)
  if (parsed instanceof Response) return parsed
  const value = parsed.body
  const state: SessionRouteState | null =
    value.state === "active" || value.state === "archived" || value.state === "removed"
      ? value.state
      : null
  if (
    !validMutationId(value.mutationId) ||
    !validGeneration(value.generation) ||
    !validInstallationId(value.installationId) ||
    typeof value.userId !== "string" ||
    value.userId.length === 0 ||
    value.userId.length > 256 ||
    typeof value.repositoryId !== "string" ||
    !/^\d+$/.test(value.repositoryId) ||
    typeof value.pullRequestNumber !== "number" ||
    !Number.isSafeInteger(value.pullRequestNumber) ||
    value.pullRequestNumber <= 0 ||
    !validRelaySessionId(value.relaySessionId) ||
    !state
  ) {
    return json({ error: "Invalid session route registration" }, 400)
  }
  const mutation: SessionRouteMutation = {
    mutationId: value.mutationId,
    generation: value.generation,
    state,
    userId: value.userId,
    installationId: value.installationId,
    repositoryId: value.repositoryId,
    pullRequestNumber: value.pullRequestNumber,
    relaySessionId: value.relaySessionId
  }
  return startRegistration(env, mutation.mutationId, { kind: "session-route", mutation })
}

const health = (env: Env): Response => {
  const bindings = {
    sessionEvents: env.SESSION_EVENTS !== undefined,
    installationRoutes: env.INSTALLATION_ROUTES !== undefined,
    deliveryWorkflow: env.GITHUB_DELIVERY_WORKFLOW !== undefined,
    registrationWorkflow: env.RELAY_REGISTRATION_WORKFLOW !== undefined,
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
      if (request.method === "POST" && url.pathname === "/internal/session-routes") {
        return await handleInternalSessionRoute(request, env)
      }
      if (request.method === "POST" && url.pathname === "/internal/installations") {
        return await handleInternalInstallation(request, env)
      }
      if (request.method === "POST" && url.pathname === "/internal/revoke") {
        return await handleInternalInstallation(request, env, true)
      }
      return json({ error: "Not found" }, 404)
    } catch (error) {
      console.error({
        level: "error",
        message: "GitHub relay request failed",
        method: request.method,
        path: url.pathname,
        error: error instanceof Error ? error.name : "UnknownError"
      })
      return json({ error: "Relay unavailable" }, 503)
    }
  }
} satisfies ExportedHandler<Env>
