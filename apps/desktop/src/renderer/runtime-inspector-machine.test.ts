import { createActor } from "xstate"
import { describe, expect, it, vi } from "vitest"
import { CURRENT_RUNTIME_CONTRACTS, type RuntimeDiagnosticSnapshot } from "@jingler/core"
import { createRuntimeInspectorMachine } from "./runtime-inspector-machine.js"

const snapshot: RuntimeDiagnosticSnapshot = {
  runId: "run-1", sessionId: null, connectionId: null, authRoute: null, accountFingerprint: null,
  versions: CURRENT_RUNTIME_CONTRACTS, promptHash: "hash", promptSections: [], activeToolIds: [], mode: "read-only",
  retries: 0, mutations: [], fileChangeStatuses: [], mcpHealth: [], terminalCause: "done", updatedAt: "2026-08-10T00:00:00.000Z"
}

const waitForState = (actor: ReturnType<typeof createActor>, state: string): Promise<void> =>
  new Promise((resolve) => {
    const subscription = actor.subscribe((next) => {
      if (next.matches(state)) {
        subscription.unsubscribe()
        resolve()
      }
    })
  })

describe("runtime inspector machine", () => {
  it("loads, refreshes, and exports through explicit states", async () => {
    const api = { latest: vi.fn(async () => snapshot), export: vi.fn(async () => JSON.stringify(snapshot)) }
    const actor = createActor(createRuntimeInspectorMachine(api)).start()
    await waitForState(actor, "ready")
    expect(actor.getSnapshot().context.snapshot).toEqual(snapshot)
    actor.send({ type: "EXPORT" })
    await waitForState(actor, "ready")
    expect(actor.getSnapshot().context.exported).toContain("run-1")
    expect(api.export).toHaveBeenCalledWith("run-1")
  })
})
