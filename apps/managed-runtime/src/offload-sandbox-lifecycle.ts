import { getSandbox } from "@cloudflare/sandbox"
import { DurableObject } from "cloudflare:workers"
import type { ManagedRuntimeEnv } from "./runtime-env.js"
import { sandboxIdForSession } from "./runtime-identity.js"
import { fields, json, readJson } from "./worker-http.js"
import {
  OFFLOAD_SANDBOX_IDLE_SECONDS,
  shouldDestroyStaleSandbox
} from "./offload-sandbox-policy.js"

const METADATA_KEY = "offload-sandbox-lifecycle"

interface OffloadSandboxLifecycleMetadata {
  readonly subject: string
  readonly sessionId: string
  readonly sandboxId: string
  readonly generation: number
  readonly lastActiveAt: number
}

export class OffloadSandboxLifecycleObject extends DurableObject<ManagedRuntimeEnv> {
  async #metadata(): Promise<OffloadSandboxLifecycleMetadata | null> {
    return (await this.ctx.storage.get<OffloadSandboxLifecycleMetadata>(METADATA_KEY)) ?? null
  }

  async #destroy(metadata: OffloadSandboxLifecycleMetadata): Promise<void> {
    const sandbox = getSandbox(this.env.Sandbox, metadata.sandboxId, {
      transport: "rpc",
      normalizeId: true,
      enableDefaultSession: false,
      sleepAfter: "10m"
    })
    await sandbox.destroy().catch(() => undefined)
    await this.ctx.storage.deleteAll()
  }

  override async alarm(): Promise<void> {
    const metadata = await this.#metadata()
    if (metadata === null) return
    const now = Math.floor(Date.now() / 1_000)
    if (shouldDestroyStaleSandbox(metadata, now)) {
      await this.#destroy(metadata)
      return
    }
    await this.ctx.storage.setAlarm(
      (metadata.lastActiveAt + OFFLOAD_SANDBOX_IDLE_SECONDS) * 1_000
    )
  }

  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url)
    const body = request.method === "POST" ? fields(await readJson(request)) : null
    const subject = typeof body?.subject === "string" ? body.subject : null
    const sessionId = typeof body?.sessionId === "string" ? body.sessionId : null
    if (subject === null || sessionId === null) {
      return json({ error: "subject and sessionId are required" }, 400)
    }
    const existing = await this.#metadata()
    if (
      existing !== null &&
      (existing.subject !== subject || existing.sessionId !== sessionId)
    ) {
      return json({ error: "sandbox lifecycle scope changed" }, 409)
    }
    if (url.pathname === "/v1/touch" && request.method === "POST") {
      const now = Math.floor(Date.now() / 1_000)
      const metadata: OffloadSandboxLifecycleMetadata = {
        subject,
        sessionId,
        sandboxId: existing?.sandboxId ?? await sandboxIdForSession(`offload_${sessionId}`),
        generation: (existing?.generation ?? 0) + 1,
        lastActiveAt: now
      }
      await this.ctx.storage.put(METADATA_KEY, metadata)
      await this.ctx.storage.setAlarm((now + OFFLOAD_SANDBOX_IDLE_SECONDS) * 1_000)
      return json(metadata)
    }
    if (url.pathname === "/v1/destroy" && request.method === "POST") {
      if (existing !== null) await this.#destroy(existing)
      return json({ destroyed: existing !== null })
    }
    if (url.pathname === "/v1/status" && request.method === "POST") {
      return json({ metadata: existing })
    }
    return json({ error: "Not found" }, 404)
  }
}
