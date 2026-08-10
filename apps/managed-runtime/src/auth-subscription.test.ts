import { describe, expect, it } from "vitest"
import {
  ManagedAuthSubscriptionLedger,
  type ManagedAuthSnapshot
} from "./auth-subscription.js"

const snapshot = (version = 1): ManagedAuthSnapshot => ({
  subject: "user_123",
  version,
  issuedAt: 100,
  expiresAt: 500,
  capabilities: ["managed.session.execute"],
  credentialCapabilities: []
})

describe("ManagedAuthSubscriptionLedger", () => {
  it("shares one auth-state subscription across active session sandboxes", () => {
    const ledger = new ManagedAuthSubscriptionLedger("user_123")
    expect(ledger.registerSession("session_1", 100)).toEqual({ subscribe: true })
    ledger.apply(snapshot(), { leaseExpiresAt: 400 })
    expect(ledger.registerSession("session_1", 101)).toEqual({ subscribe: false })
    expect(ledger.snapshot().activeSessionIds).toEqual(["session_1"])
  })

  it("rejects commands while auth-state subscription stale", () => {
    const ledger = new ManagedAuthSubscriptionLedger("user_123")
    ledger.registerSession("session_1", 100)
    ledger.apply(snapshot(), { leaseExpiresAt: 110 })
    expect(ledger.authorize("managed.session.execute", 111)).toEqual({
      admitted: false,
      reason: "auth-stale"
    })
  })

  it("reacquires versioned snapshot after hibernation", () => {
    const original = new ManagedAuthSubscriptionLedger("user_123")
    original.registerSession("session_1", 100)
    original.apply(snapshot(), { leaseExpiresAt: 110 })

    const restored = new ManagedAuthSubscriptionLedger(
      "user_123",
      original.snapshot()
    )
    expect(restored.needsSubscription(111)).toBe(true)
    expect(restored.apply(snapshot(2), { leaseExpiresAt: 600 })).toBe(true)
    expect(restored.authorize("managed.session.execute", 112)).toEqual({
      admitted: true,
      authStateVersion: 2
    })
  })

  it("releases the per-user slot when a lifecycle interval settles", () => {
    const ledger = new ManagedAuthSubscriptionLedger("user_123")
    ledger.registerSession("session_1", 100)
    ledger.apply(snapshot(), { leaseExpiresAt: 400 })
    ledger.unregisterSession("session_1")

    expect(ledger.registerSession("session_2", 101)).toEqual({ subscribe: false })
    expect(ledger.snapshot().activeSessionIds).toEqual(["session_2"])
  })
})
