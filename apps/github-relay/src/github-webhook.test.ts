import { describe, expect, it } from "vitest"
import {
  normalizeGitHubWebhook,
  readBoundedWebhookBody,
  verifyGitHubWebhookSignature,
  WebhookBodyTooLargeError
} from "./github-webhook.js"
import { githubPayload, hmacHex } from "./test-support.js"

describe("GitHub webhook verification", () => {
  it("verifies the exact raw bytes and rejects malformed or altered signatures", async () => {
    const body = JSON.stringify(githubPayload())
    const signature = await hmacHex(body, "webhook-secret")
    await expect(
      verifyGitHubWebhookSignature(
        new TextEncoder().encode(body).buffer,
        `sha256=${signature}`,
        "webhook-secret"
      )
    ).resolves.toBe(true)
    await expect(
      verifyGitHubWebhookSignature(
        new TextEncoder().encode(`${body} `).buffer,
        `sha256=${signature}`,
        "webhook-secret"
      )
    ).resolves.toBe(false)
    await expect(
      verifyGitHubWebhookSignature(new ArrayBuffer(0), "sha256=bad", "webhook-secret")
    ).resolves.toBe(false)
  })

  it("bounds bodies even when content-length is absent", async () => {
    const request = new Request("https://relay.test/webhooks/github", {
      method: "POST",
      body: "12345"
    })
    await expect(readBoundedWebhookBody(request, 4)).rejects.toBeInstanceOf(WebhookBodyTooLargeError)
  })
})

describe("GitHub webhook normalization", () => {
  it("marks a new human PR comment actionable with session-routing context", async () => {
    await expect(
      normalizeGitHubWebhook({
        deliveryId: "delivery-1",
        eventName: "issue_comment",
        payload: githubPayload()
      })
    ).resolves.toMatchObject({
      deliveryId: "delivery-1",
      installationId: "99",
      actionable: true,
      repository: { id: "10", fullName: "acme/jingler" },
      pullRequest: { number: 42 },
      feedback: { kind: "issue-comment", body: "Please cover reconnect replay." }
    })
  })

  it("delivers bot and state events for invalidation but never marks them actionable", async () => {
    const bot = await normalizeGitHubWebhook({
      deliveryId: "delivery-bot",
      eventName: "issue_comment",
      payload: githubPayload({ sender: { id: 8, login: "jingler[bot]", type: "Bot" } })
    })
    expect(bot).toMatchObject({ actionable: false })

    const state = await normalizeGitHubWebhook({
      deliveryId: "delivery-state",
      eventName: "pull_request",
      payload: githubPayload({
        action: "review_requested",
        pull_request: {
          id: 200,
          number: 42,
          title: "Improve relay",
          html_url: "https://github.com/acme/jingler/pull/42",
          updated_at: "2026-08-05T10:00:00Z",
          head: { sha: "head" },
          base: { sha: "base" }
        }
      })
    })
    expect(state).toMatchObject({ event: "pull_request", actionable: false })

    const status = await normalizeGitHubWebhook({
      deliveryId: "delivery-status",
      eventName: "status",
      payload: githubPayload({
        action: undefined,
        state: "success",
        sha: "head",
        updated_at: "2026-08-05T10:01:00Z"
      })
    })
    expect(status).toMatchObject({
      event: "status",
      action: "success",
      actionable: false,
      pullRequest: null,
      occurredAt: "2026-08-05T10:01:00Z"
    })
  })

  it("uses a content-derived semantic key so unchanged edits deduplicate downstream", async () => {
    const created = await normalizeGitHubWebhook({
      deliveryId: "delivery-created",
      eventName: "issue_comment",
      payload: githubPayload({ action: "created" })
    })
    const edited = await normalizeGitHubWebhook({
      deliveryId: "delivery-edited",
      eventName: "issue_comment",
      payload: githubPayload({ action: "edited" })
    })
    expect(created?.semanticKey).toBe(edited?.semanticKey)
    expect(edited?.actionable).toBe(false)
  })

  it("ignores unsupported events and issue comments that are not on pull requests", async () => {
    await expect(
      normalizeGitHubWebhook({ deliveryId: "d", eventName: "push", payload: githubPayload() })
    ).resolves.toBeNull()
    await expect(
      normalizeGitHubWebhook({
        deliveryId: "d2",
        eventName: "issue_comment",
        payload: githubPayload({ issue: { id: 1, number: 2 } })
      })
    ).resolves.toBeNull()
  })
})
