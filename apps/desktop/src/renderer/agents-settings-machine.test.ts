import { ManagedResourceId, type ManagedResource } from "@jingler/core"
import { Schema } from "effect"
import { createActor, waitFor } from "xstate"
import { describe, expect, it, vi } from "vitest"
import { createAgentsSettingsMachine } from "./agents-settings-machine.js"

const resourceId = Schema.decodeUnknownSync(ManagedResourceId)("review")
const resource: ManagedResource = {
  id: resourceId,
  kind: "prompt",
  name: "Review",
  description: "Review changes",
  enabled: true,
  trust: "operator-approved",
  scope: { kind: "portable", allowedTargets: [] },
  managedPath: "/managed/review.md",
  byteLength: 14,
  provenance: {
    origin: "jingler",
    sourceRoot: "/managed",
    sourcePath: "/source/review.md",
    importedAt: "2026-08-10T00:00:00.000Z"
  }
}

describe("agents settings machine", () => {
  it("loads, detects, imports, mutates, and receives watch updates", async () => {
    const subscription: {
      listener: ((resources: ReadonlyArray<ManagedResource>) => void) | null
    } = { listener: null }
    const api = {
      list: vi.fn(async () => [] as ReadonlyArray<ManagedResource>),
      detect: vi.fn(async () => ({ candidates: [{
        id: resourceId,
        kind: "prompt" as const,
        name: "Review",
        description: "Review changes",
        byteLength: 14,
        provenance: resource.provenance
      }], skipped: [] })),
      importFiles: vi.fn(async () => ({ imported: [resource.id], skipped: [] })),
      setEnabled: vi.fn(async () => undefined),
      remove: vi.fn(async () => undefined),
      reveal: vi.fn(async () => undefined),
      watch: vi.fn((next: (resources: ReadonlyArray<ManagedResource>) => void) => {
        subscription.listener = next
        return () => undefined
      })
    }
    const actor = createActor(createAgentsSettingsMachine(api)).start()
    await waitFor(actor, (snapshot) => snapshot.matches("ready"))
    subscription.listener?.([resource])
    expect(actor.getSnapshot().context.resources).toEqual([resource])

    actor.send({ type: "DETECT" })
    await waitFor(actor, (snapshot) => snapshot.matches("reviewing"))
    expect(actor.getSnapshot().context.selectedCandidateIds.has(resourceId)).toBe(true)
    actor.send({ type: "IMPORT_SELECTED" })
    await waitFor(actor, (snapshot) => snapshot.matches("ready"))
    expect(api.importFiles).toHaveBeenCalledWith([expect.objectContaining({ id: "review" })])

    actor.send({
      type: "SET_ENABLED",
      selector: { id: resource.id },
      enabled: false
    })
    await waitFor(actor, (snapshot) => snapshot.matches("ready"))
    expect(api.setEnabled).toHaveBeenCalledWith({ id: resource.id }, false)
  })
})
