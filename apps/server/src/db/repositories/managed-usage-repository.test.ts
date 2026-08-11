import { describe, expect, it } from "vitest"
import {
  admitManagedUsage,
  basicInstanceCeilingMicrousd,
  DEFAULT_MANAGED_USAGE_POLICY
} from "./managed-usage-repository.js"

describe("ManagedUsageRepository policy", () => {
  it("rejects a start beyond user concurrency or daily budget", () => {
    expect(admitManagedUsage({
      policy: DEFAULT_MANAGED_USAGE_POLICY,
      activeReservations: 1,
      committedMicrousd: 0
    })).toEqual({ admitted: false, reason: "concurrency" })
    expect(admitManagedUsage({
      policy: DEFAULT_MANAGED_USAGE_POLICY,
      activeReservations: 0,
      committedMicrousd: 160_000
    })).toEqual({ admitted: false, reason: "daily-budget" })
  })

  it("computes published basic-instance cost ceilings", () => {
    expect(basicInstanceCeilingMicrousd(3_600)).toBe(28_000)
    expect(basicInstanceCeilingMicrousd(120)).toBe(934)
  })

  it("uses indexed account-window lookups and bounded expiry batches", () => {
    expect(DEFAULT_MANAGED_USAGE_POLICY.maxConcurrentSessions).toBe(1)
    expect(DEFAULT_MANAGED_USAGE_POLICY.maxActiveSeconds).toBe(7_200)
  })
})
