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
  it("opens each review once", async () => {
    const { claimPlanAutoPresentation } = await import("./plan-presence.js")

    expect(claimPlanAutoPresentation("chat-1", "review-1")).toBe(true)
    expect(claimPlanAutoPresentation("chat-1", "review-1")).toBe(false)
    expect(claimPlanAutoPresentation("chat-1", "review-2")).toBe(true)
  })

  it("remembers the current review across a renderer restart", async () => {
    const firstModule = await import("./plan-presence.js")
    expect(firstModule.claimPlanAutoPresentation("chat-1", "review-1")).toBe(true)
    vi.resetModules()
    const restartedModule = await import("./plan-presence.js")

    expect(restartedModule.claimPlanAutoPresentation("chat-1", "review-1")).toBe(false)
    expect(restartedModule.claimPlanAutoPresentation("chat-1", "review-2")).toBe(true)
  })

  it("clears only the deleted chat", async () => {
    const {
      claimPlanAutoPresentation,
      clearPlanAutoPresentation,
      planAutoPresentationStorageKey
    } = await import("./plan-presence.js")

    expect(claimPlanAutoPresentation("chat-1", "review-1")).toBe(true)
    expect(claimPlanAutoPresentation("chat-2", "review-1")).toBe(true)
    clearPlanAutoPresentation("chat-1")

    expect(storage.getItem(planAutoPresentationStorageKey("chat-1"))).toBeNull()
    expect(claimPlanAutoPresentation("chat-1", "review-1")).toBe(true)
    expect(claimPlanAutoPresentation("chat-2", "review-1")).toBe(false)
  })
})
