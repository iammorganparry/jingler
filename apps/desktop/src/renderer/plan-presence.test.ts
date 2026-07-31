import { beforeEach, describe, expect, it, vi } from "vitest"

class MemoryStorage {
  private readonly values = new Map<string, string>()

  getItem(key: string): string | null {
    return this.values.get(key) ?? null
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value)
  }

  removeItem(key: string): void {
    this.values.delete(key)
  }
}

let storage: MemoryStorage

beforeEach(() => {
  storage = new MemoryStorage()
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: storage
  })
  vi.resetModules()
})

describe("plan auto-presentation", () => {
  it("allows only the first plan-producing turn to auto-open per session", async () => {
    const { claimPlanAutoPresentation } = await import("./plan-presence.js")
    const sessionId = "session-first-plan"

    expect(claimPlanAutoPresentation(sessionId)).toBe(true)
    expect(claimPlanAutoPresentation(sessionId)).toBe(false)
  })

  it("survives a renderer restart", async () => {
    const firstModule = await import("./plan-presence.js")
    const sessionId = "session-restarted-plan"

    expect(firstModule.claimPlanAutoPresentation(sessionId)).toBe(true)
    vi.resetModules()
    const restartedModule = await import("./plan-presence.js")

    expect(restartedModule.claimPlanAutoPresentation(sessionId)).toBe(false)
  })

  it("tracks sessions independently and resets only when a session is deleted", async () => {
    const {
      claimPlanAutoPresentation,
      clearPlanAutoPresentation,
      planAutoPresentationStorageKey
    } = await import("./plan-presence.js")
    const first = "session-reset-first-plan"
    const second = "session-independent-plan"

    expect(claimPlanAutoPresentation(first)).toBe(true)
    expect(claimPlanAutoPresentation(second)).toBe(true)
    expect(claimPlanAutoPresentation(first)).toBe(false)

    clearPlanAutoPresentation(first)

    expect(storage.getItem(planAutoPresentationStorageKey(first))).toBeNull()
    expect(claimPlanAutoPresentation(first)).toBe(true)
    expect(claimPlanAutoPresentation(second)).toBe(false)
  })
})
