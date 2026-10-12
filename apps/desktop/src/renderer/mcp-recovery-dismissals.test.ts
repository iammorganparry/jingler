import { afterEach, beforeEach, describe, expect, it } from "vitest"
import {
  clearMcpRecoveryDismissal,
  dismissMcpRecovery,
  isMcpRecoveryDismissed,
  mcpRecoveryKey
} from "./mcp-recovery-dismissals.js"

class MemoryStorage {
  private readonly values = new Map<string, string>()
  getItem(key: string): string | null {
    return this.values.get(key) ?? null
  }
  setItem(key: string, value: string): void {
    this.values.set(key, value)
  }
}

beforeEach(() => {
  ;(globalThis as { localStorage?: unknown }).localStorage = new MemoryStorage()
})
afterEach(() => {
  ;(globalThis as { localStorage?: unknown }).localStorage = undefined
})

const runpod = { name: "runpod", authKind: "oauth" }

describe("mcp recovery dismissals", () => {
  it("survives a reload (read back from storage, not module state)", () => {
    dismissMcpRecovery(mcpRecoveryKey(runpod))
    expect(isMcpRecoveryDismissed(mcpRecoveryKey(runpod))).toBe(true)
  })

  it("shows the card again after the server recovers and fails anew", () => {
    dismissMcpRecovery(mcpRecoveryKey(runpod))
    clearMcpRecoveryDismissal(mcpRecoveryKey(runpod)) // server seen healthy
    expect(isMcpRecoveryDismissed(mcpRecoveryKey(runpod))).toBe(false)
  })

  it("shows the card again when the auth kind changes, and is per server", () => {
    dismissMcpRecovery(mcpRecoveryKey(runpod))
    expect(isMcpRecoveryDismissed(mcpRecoveryKey({ ...runpod, authKind: "api-key" }))).toBe(false)
    expect(isMcpRecoveryDismissed(mcpRecoveryKey({ name: "other", authKind: "oauth" }))).toBe(false)
  })

  it("tolerates missing or corrupt storage", () => {
    ;(globalThis as { localStorage?: unknown }).localStorage = undefined
    expect(isMcpRecoveryDismissed("x:oauth")).toBe(false)
    expect(() => dismissMcpRecovery("x:oauth")).not.toThrow()
    ;(globalThis as { localStorage?: unknown }).localStorage = { getItem: () => "{not json", setItem: () => {} }
    expect(isMcpRecoveryDismissed("x:oauth")).toBe(false)
  })
})
