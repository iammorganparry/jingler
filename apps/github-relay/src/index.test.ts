import { env, introspectWorkflow, SELF } from "cloudflare:test"
import { describe, expect, it } from "vitest"
import { githubPayload, hmacHex, issueTestRelayGrant } from "./test-support.js"

const signedWebhook = async (
  deliveryId: string,
  payload: unknown = githubPayload(),
  eventName = "issue_comment"
): Promise<Response> => {
  const body = JSON.stringify(payload)
  return SELF.fetch("https://relay.test/webhooks/github", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-github-delivery": deliveryId,
      "x-github-event": eventName,
      "x-hub-signature-256": `sha256=${await hmacHex(body, "test-webhook-secret")}`
    },
    body
  })
}

const signedInternal = async (path: string, payload: unknown): Promise<Response> => {
  const body = JSON.stringify(payload)
  const timestamp = String(Math.floor(Date.now() / 1_000))
  const signature = await hmacHex(`${timestamp}.${body}`, "test-relay-signing-secret")
  return SELF.fetch(`https://relay.test${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-jingler-timestamp": timestamp,
      "x-jingler-signature": `sha256=${signature}`
    },
    body
  })
}

const registerRouteDirectly = async (
  relaySessionId: string,
  pullRequestNumber = 42,
  installationId = "99",
  repositoryId = "10"
) => {
  const routes = env.INSTALLATION_ROUTES.getByName(installationId)
  await routes.setOwner("user-1", "active", installationId, 1, `owner-${relaySessionId}`)
  await routes.applySessionRoute({
    mutationId: `route-${relaySessionId}`,
    generation: 1,
    state: "active",
    userId: "user-1",
    installationId,
    repositoryId,
    pullRequestNumber,
    relaySessionId
  })
}

const nextMessage = (socket: WebSocket): Promise<Record<string, unknown>> =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Timed out waiting for websocket message")), 2_000)
    socket.addEventListener(
      "message",
      (message) => {
        clearTimeout(timer)
        resolve(JSON.parse(String(message.data)) as Record<string, unknown>)
      },
      { once: true }
    )
  })

describe("GitHub relay HTTP boundary", () => {
  it("reports Durable Object and Workflow binding health", async () => {
    const response = await SELF.fetch("https://relay.test/health")
    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({
      status: "ok",
      bindings: {
        sessionEvents: true,
        installationRoutes: true,
        deliveryWorkflow: true,
        registrationWorkflow: true
      }
    })
  })

  it("rejects invalid signatures before parsing payloads", async () => {
    const response = await SELF.fetch("https://relay.test/webhooks/github", {
      method: "POST",
      headers: {
        "x-github-delivery": "invalid-signature-delivery",
        "x-github-event": "issue_comment",
        "x-hub-signature-256": `sha256=${"a".repeat(64)}`
      },
      body: "not-json"
    })
    expect(response.status).toBe(401)
  })

  it("creates one deterministic delivery Workflow for duplicate GitHub deliveries", async () => {
    const installationId = "9911"
    const repositoryId = "1011"
    await registerRouteDirectly("relay-session-workflow-1", 42, installationId, repositoryId)
    const introspector = await introspectWorkflow(env.GITHUB_DELIVERY_WORKFLOW)
    try {
      const payload = githubPayload({
        installation: { id: Number(installationId) },
        repository: {
          id: Number(repositoryId),
          name: "jingler",
          full_name: "acme/jingler",
          owner: { login: "acme" }
        }
      })
      const first = await signedWebhook("deterministic-delivery", payload)
      const duplicate = await signedWebhook("deterministic-delivery", payload)
      expect(first.status).toBe(202)
      expect(duplicate.status).toBe(202)
      const firstBody = (await first.json()) as { workflowId: string; duplicate: boolean }
      const duplicateBody = (await duplicate.json()) as { workflowId: string; duplicate: boolean }
      expect(firstBody.workflowId).toBe(duplicateBody.workflowId)
      expect(firstBody.duplicate).toBe(false)
      expect(duplicateBody.duplicate).toBe(true)
      const [instance] = await introspector.get()
      expect(instance).toBeDefined()
      await instance!.waitForStatus("complete")
      await expect(env.SESSION_EVENTS.getByName("relay-session-workflow-1").eventCount()).resolves.toBe(1)
    } finally {
      await introspector.dispose()
    }
  })

  it("drops non-actionable CI state before creating a delivery Workflow", async () => {
    const introspector = await introspectWorkflow(env.GITHUB_DELIVERY_WORKFLOW)
    try {
      const response = await signedWebhook(
        "ignored-check-run",
        githubPayload({
          action: "completed",
          check_run: {
            id: 501,
            updated_at: "2026-08-07T10:02:00Z",
            pull_requests: [
              {
                id: 200,
                number: 42,
                url: "https://api.github.com/repos/acme/jingler/pulls/42",
                head: { sha: "head" },
                base: { sha: "base" }
              }
            ]
          }
        }),
        "check_run"
      )

      expect(response.status).toBe(202)
      await expect(response.json()).resolves.toMatchObject({
        accepted: true,
        ignored: true,
        reason: "not_actionable"
      })
      await expect(introspector.get()).resolves.toHaveLength(0)
    } finally {
      await introspector.dispose()
    }
  })

  it("accepts signed session route registration through a deterministic Workflow", async () => {
    await env.INSTALLATION_ROUTES.getByName("99").setOwner(
      "user-1",
      "active",
      "99",
      1,
      "owner-session-route-http"
    )
    const introspector = await introspectWorkflow(env.RELAY_REGISTRATION_WORKFLOW)
    const response = await signedInternal("/internal/session-routes", {
      mutationId: "session-route-http",
      generation: 1,
      state: "active",
      userId: "user-1",
      installationId: "99",
      repositoryId: "10",
      pullRequestNumber: 44,
      relaySessionId: "relay-session-http-0001"
    })
    expect(response.status).toBe(202)
    try {
      const [instance] = await introspector.get()
      expect(instance).toBeDefined()
      await instance!.waitForStatus("complete")
      await expect(env.INSTALLATION_ROUTES.getByName("99").resolveRoute("10", 44)).resolves.toMatchObject({
        relaySessionId: "relay-session-http-0001"
      })
    } finally {
      await introspector.dispose()
    }
  })
})

describe("session-scoped websocket delivery", () => {
  it("opens only the Durable Object named by the signed session grant", async () => {
    const relaySessionId = "relay-session-socket-0001"
    await registerRouteDirectly(relaySessionId)
    const now = Math.floor(Date.now() / 1_000)
    const grant = await issueTestRelayGrant({
      relaySessionId,
      issuedAt: now,
      expiresAt: now + 300
    })
    const response = await SELF.fetch("https://relay.test/events?clientId=desktop-1&cursor=0", {
      headers: { Upgrade: "websocket", Authorization: `Bearer ${grant}` }
    })
    expect(response.status).toBe(101)
    const socket = response.webSocket!
    const hello = nextMessage(socket)
    socket.accept()
    await expect(hello).resolves.toMatchObject({ type: "hello", cursor: 0 })

    const introspector = await introspectWorkflow(env.GITHUB_DELIVERY_WORKFLOW)
    try {
      const eventMessage = nextMessage(socket)
      await signedWebhook("socket-delivery")
      const [instance] = await introspector.get()
      expect(instance).toBeDefined()
      await instance!.waitForStatus("complete")
      await expect(eventMessage).resolves.toMatchObject({
        type: "event",
        event: { deliveryId: "socket-delivery" }
      })
      await expect(env.SESSION_EVENTS.getByName("relay-session-unrelated").eventCount()).resolves.toBe(0)
    } finally {
      socket.close(1000, "done")
      await introspector.dispose()
    }
  })

  it("rejects a valid grant whose user does not own the session route", async () => {
    await registerRouteDirectly("relay-session-owned-0001")
    const now = Math.floor(Date.now() / 1_000)
    const grant = await issueTestRelayGrant({
      subject: "another-user",
      relaySessionId: "relay-session-owned-0001",
      issuedAt: now,
      expiresAt: now + 300
    })
    const response = await SELF.fetch("https://relay.test/events?clientId=desktop-2&cursor=0", {
      headers: { Upgrade: "websocket", Authorization: `Bearer ${grant}` }
    })
    expect(response.status).toBe(403)
  })
})
