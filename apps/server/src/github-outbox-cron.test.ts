import { describe, expect, it, vi } from "vitest"
import { handleGitHubOutboxCron } from "./github-outbox-cron.js"

describe("GitHub outbox cron", () => {
  it("rejects requests without the Vercel cron bearer", async () => {
    const drain = vi.fn()
    const response = await handleGitHubOutboxCron(
      new Request("https://api.jingler.dev/api/cron/github-outbox"),
      "a-production-cron-secret",
      drain
    )
    expect(response.status).toBe(401)
    expect(drain).not.toHaveBeenCalled()
  })

  it("drains both durable GitHub outboxes for an authenticated schedule", async () => {
    const drain = vi.fn().mockResolvedValue(undefined)
    const response = await handleGitHubOutboxCron(
      new Request("https://api.jingler.dev/api/cron/github-outbox", {
        headers: { authorization: "Bearer a-production-cron-secret" }
      }),
      "a-production-cron-secret",
      drain
    )
    expect(response.status).toBe(200)
    expect(drain).toHaveBeenCalledOnce()
  })

  it("keeps a failed drain retryable by returning a non-success response", async () => {
    const response = await handleGitHubOutboxCron(
      new Request("https://api.jingler.dev/api/cron/github-outbox", {
        headers: { authorization: "Bearer a-production-cron-secret" }
      }),
      "a-production-cron-secret",
      vi.fn().mockRejectedValue(new Error("relay offline"))
    )
    expect(response.status).toBe(503)
  })
})
