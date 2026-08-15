import { DurableObject } from "cloudflare:workers"
import {
  decodeManagedAuthSnapshot,
  emptyManagedAuthState,
  ManagedAuthSubscriptionLedger,
  type ManagedAuthState
} from "./auth-subscription.js"
import type { ManagedRuntimeEnv } from "./runtime-env.js"
import { fields, json, readJson } from "./worker-http.js"

const STATE_KEY = "auth-coordinator"
const USER_KEY = "user-id"
const SUBSCRIPTION_RENEWAL_SKEW_SECONDS = 30
const OFFLOAD_JOBS_KEY = "offload-jobs"
const OFFLOAD_USES_KEY = "offload-grant-uses"
const OFFLOAD_SLOT_SECONDS = 2 * 60 * 60

interface ActiveOffloadJob {
  readonly jobId: string
  readonly idempotencyKey: string
  readonly expiresAt: number
}

/** One coordinator per account; it is the only auth-state subscriber for its sandboxes. */
export class ManagedAccountObject extends DurableObject<ManagedRuntimeEnv> {
  async #ledger(subject: string): Promise<ManagedAuthSubscriptionLedger> {
    const restored =
      (await this.ctx.storage.get<ManagedAuthState>(STATE_KEY)) ?? emptyManagedAuthState()
    return new ManagedAuthSubscriptionLedger(subject, restored)
  }

  async #persist(ledger: ManagedAuthSubscriptionLedger): Promise<void> {
    await this.ctx.storage.put(STATE_KEY, ledger.snapshot())
  }

  async #fanOut(state: ManagedAuthState): Promise<void> {
    await Promise.all(
      state.activeSessionIds.map((sessionId) =>
        this.env.MANAGED_SESSION.getByName(sessionId).fetch(
          "https://managed-session.internal/v1/auth-state",
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ snapshot: state.snapshot })
          }
        )
      )
    )
  }

  async #subscribe(subject: string): Promise<boolean> {
    const response = await this.env.AUTH_STATE.getByName(subject).fetch(
      "https://auth-state.internal/v1/subscriptions/managed-runtime",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-jingler-service-secret": this.env.AUTH_STATE_SERVICE_SECRET
        },
        body: JSON.stringify({
          subject,
          subscriberId: `managed:${subject}`,
          callbackUrl: `${this.env.MANAGED_RUNTIME_ORIGIN}/v1/internal/auth/${encodeURIComponent(subject)}`
        })
      }
    )
    if (!response.ok) return false
    const body = fields(await response.json())
    const snapshot = decodeManagedAuthSnapshot(body?.snapshot)
    const leaseExpiresAt = body?.leaseExpiresAt
    if (
      snapshot === null ||
      typeof leaseExpiresAt !== "number" ||
      !Number.isSafeInteger(leaseExpiresAt)
    ) {
      return false
    }
    const ledger = await this.#ledger(subject)
    if (!ledger.apply(snapshot, { leaseExpiresAt })) return false
    await this.#persist(ledger)
    await this.ctx.storage.setAlarm(
      Math.max(Date.now() + 1_000, (leaseExpiresAt - SUBSCRIPTION_RENEWAL_SKEW_SECONDS) * 1_000)
    )
    await this.#fanOut(ledger.snapshot())
    return true
  }

  override async alarm(): Promise<void> {
    const subject = await this.ctx.storage.get<string>(USER_KEY)
    if (subject === undefined) return
    if (!(await this.#subscribe(subject))) {
      const ledger = await this.#ledger(subject)
      ledger.disconnect()
      await this.#persist(ledger)
      await this.#fanOut(ledger.snapshot())
    }
  }

  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url)
    const body = request.method === "POST" ? fields(await readJson(request)) : null
    const subject = typeof body?.subject === "string" ? body.subject : null
    if (subject === null) return json({ error: "subject is required" }, 400)
    await this.ctx.storage.put(USER_KEY, subject)
    const ledger = await this.#ledger(subject)

    if (url.pathname === "/v1/offload/authorize" && request.method === "POST") {
      const now = Math.floor(Date.now() / 1_000)
      const connected = !ledger.needsSubscription(now) || (await this.#subscribe(subject))
      const current = connected ? await this.#ledger(subject) : ledger
      const auth = current.authorize("managed.session.execute", now)
      const githubCapabilityHandle = current.credentialHandle("github", now)
      return connected && auth.admitted && githubCapabilityHandle !== null
        ? json({ authStateVersion: auth.authStateVersion, githubCapabilityHandle, claimed: false })
        : json({ error: "Managed offload is not authorized" }, 403)
    }

    if (url.pathname === "/v1/offload/register" && request.method === "POST") {
      const jobId = typeof body?.jobId === "string" ? body.jobId : null
      const idempotencyKey = typeof body?.idempotencyKey === "string"
        ? body.idempotencyKey
        : null
      if (jobId === null || idempotencyKey === null) {
        return json({ error: "job scope is required" }, 400)
      }
      const now = Math.floor(Date.now() / 1_000)
      const connected = !ledger.needsSubscription(now) || (await this.#subscribe(subject))
      const current = connected ? await this.#ledger(subject) : ledger
      const auth = current.authorize("managed.session.execute", now)
      const githubCapabilityHandle = current.credentialHandle("github", now)
      if (!(connected && auth.admitted && githubCapabilityHandle !== null)) {
        return json({ error: "Managed offload is not authorized" }, 403)
      }
      const active = (
        (await this.ctx.storage.get<ReadonlyArray<ActiveOffloadJob>>(OFFLOAD_JOBS_KEY)) ?? []
      ).filter((candidate) => candidate.expiresAt > now)
      const existing = active.find((candidate) => candidate.idempotencyKey === idempotencyKey)
      if (existing !== undefined && existing.jobId !== jobId) {
        return json({ error: "Offload idempotency scope changed" }, 409)
      }
      if (existing === undefined && active.length >= 1) {
        return json({ error: "Offload concurrency exceeded" }, 429)
      }
      if (existing === undefined) {
        active.push({ jobId, idempotencyKey, expiresAt: now + OFFLOAD_SLOT_SECONDS })
        await this.ctx.storage.put(OFFLOAD_JOBS_KEY, active)
      }
      return json({
        authStateVersion: auth.authStateVersion,
        githubCapabilityHandle,
        claimed: existing === undefined
      })
    }

    if (url.pathname === "/v1/offload/unregister" && request.method === "POST") {
      const jobId = typeof body?.jobId === "string" ? body.jobId : null
      if (jobId === null) return json({ error: "jobId is required" }, 400)
      const active =
        (await this.ctx.storage.get<ReadonlyArray<ActiveOffloadJob>>(OFFLOAD_JOBS_KEY)) ?? []
      await this.ctx.storage.put(
        OFFLOAD_JOBS_KEY,
        active.filter((candidate) => candidate.jobId !== jobId)
      )
      return json({ ok: true })
    }

    if (url.pathname === "/v1/offload/grants/consume" && request.method === "POST") {
      const use = typeof body?.use === "string" ? body.use : null
      if (use === null) return json({ error: "grant use is required" }, 400)
      const uses = new Set(
        (await this.ctx.storage.get<ReadonlyArray<string>>(OFFLOAD_USES_KEY)) ?? []
      )
      if (uses.has(use)) return json({ error: "Offload grant was already used" }, 409)
      uses.add(use)
      await this.ctx.storage.put(OFFLOAD_USES_KEY, [...uses].slice(-256))
      return json({ consumed: true })
    }

    if (url.pathname === "/v1/sessions/register" && request.method === "POST") {
      const sessionId = typeof body?.sessionId === "string" ? body.sessionId : null
      const claimSlot = typeof body?.claimSlot === "boolean" ? body.claimSlot : null
      if (sessionId === null) return json({ error: "sessionId is required" }, 400)
      if (claimSlot === null) return json({ error: "claimSlot is required" }, 400)
      const now = Math.floor(Date.now() / 1_000)
      const connected = !ledger.needsSubscription(now) || (await this.#subscribe(subject))
      const current = connected ? await this.#ledger(subject) : ledger
      const auth = current.authorize("managed.session.execute", now)
      const providerConnections = current.providerConnections(now)
      const webSearchCapabilities = current.webSearchCapabilities(now)
      const githubCapabilityHandle = current.credentialHandle("github", now)
      if (!(connected && auth.admitted && providerConnections.length > 0)) {
        return json({
          connected,
          auth,
          providerConnections,
          webSearchCapabilities,
          githubCapabilityHandle
        })
      }
      if (claimSlot) {
        try {
          current.registerSession(sessionId, now)
        } catch {
          return json({ error: "Managed session concurrency exceeded" }, 429)
        }
        await this.#persist(current)
      }
      return json({
        connected,
        auth,
        providerConnections,
        webSearchCapabilities,
        githubCapabilityHandle
      })
    }

    if (url.pathname === "/v1/sessions/unregister" && request.method === "POST") {
      const sessionId = typeof body?.sessionId === "string" ? body.sessionId : null
      if (sessionId === null) return json({ error: "sessionId is required" }, 400)
      ledger.unregisterSession(sessionId)
      await this.#persist(ledger)
      return json({ ok: true })
    }

    if (url.pathname === "/v1/authorize" && request.method === "POST") {
      const capability = typeof body?.capability === "string" ? body.capability : null
      if (capability === null) return json({ error: "capability is required" }, 400)
      return json(ledger.authorize(capability, Math.floor(Date.now() / 1_000)))
    }

    if (url.pathname === "/v1/capabilities" && request.method === "POST") {
      const now = Math.floor(Date.now() / 1_000)
      const initial = ledger.authorize("managed.session.execute", now)
      const current =
        initial.admitted || !(await this.#subscribe(subject)) ? ledger : await this.#ledger(subject)
      const admitted = current.authorize("managed.session.execute", now).admitted
      return json({
        version: 1,
        providerConnections: admitted ? current.providerConnections(now) : [],
        webSearchCapabilities: admitted ? current.webSearchCapabilities(now) : []
      })
    }

    if (url.pathname === "/v1/sessions/list" && request.method === "POST") {
      return json({ sessionIds: ledger.snapshot().activeSessionIds })
    }

    if (url.pathname === "/v1/auth-state" && request.method === "POST") {
      const snapshot = decodeManagedAuthSnapshot(body?.snapshot)
      const leaseExpiresAt = body?.leaseExpiresAt
      if (
        snapshot === null ||
        typeof leaseExpiresAt !== "number" ||
        !Number.isSafeInteger(leaseExpiresAt)
      ) {
        return json({ error: "invalid auth snapshot" }, 400)
      }
      if (!ledger.apply(snapshot, { leaseExpiresAt })) {
        return json({ error: "stale or mismatched auth snapshot" }, 409)
      }
      await this.#persist(ledger)
      await this.#fanOut(ledger.snapshot())
      return json({ ok: true, version: snapshot.version })
    }

    return json({ error: "Not found" }, 404)
  }
}
