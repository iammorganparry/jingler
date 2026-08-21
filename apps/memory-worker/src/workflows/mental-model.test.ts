import type { MemoryObservation } from "@jingler/memory"
import { describe, expect, it } from "vitest"
import { defineMentalModel, refreshMentalModel } from "./mental-model.js"

const scope = { kind: "project" as const, id: "project-a" }
const observation = (
  id: string,
  text: string,
  observationScope = scope
): MemoryObservation => ({
  id,
  key: id,
  scope: observationScope,
  text,
  evidenceIds: [`revision:${id}`],
  version: 1,
  confidence: 1,
  createdAt: "2026-08-20T09:00:00.000Z"
})

describe("mental models", () => {
  it("versions definitions and bounded evidence-linked refreshes", () => {
    const definition = defineMentalModel({
      id: "model:conventions",
      name: "Project conventions",
      scope,
      sourceQuery: "retry conventions",
      maxTokens: 20,
      refreshAfterConsolidation: true,
      publication: "published",
      createdAt: "2026-08-20T09:00:00.000Z"
    })
    const first = refreshMentalModel(definition, [
      observation("retry", "Use bounded retry jitter."),
      observation("foreign", "Private other-project rule.", {
        kind: "project",
        id: "project-b"
      })
    ], [], "2026-08-20T10:00:00.000Z")
    const second = refreshMentalModel(
      definition,
      [observation("retry", "Use the shared bounded retry helper.")],
      [first],
      "2026-08-21T10:00:00.000Z"
    )

    expect(definition.definitionVersion).toBe(1)
    expect(first.content).toContain("bounded retry jitter")
    expect(first.content).not.toContain("other-project")
    expect(first.evidenceObservationIds).toEqual(["retry"])
    expect(second.version).toBe(2)
    expect(second.id).not.toBe(first.id)
  })

  it("increments a definition without changing its immutable scope", () => {
    const first = defineMentalModel({
      id: "model:preferences",
      name: "Preferences",
      scope,
      sourceQuery: "preferences",
      maxTokens: 100,
      refreshAfterConsolidation: false,
      publication: "draft",
      createdAt: "2026-08-20T09:00:00.000Z"
    })
    const second = defineMentalModel({ ...first, publication: "published" }, first)

    expect(second.definitionVersion).toBe(2)
    expect(second.scope).toEqual(scope)
  })
})
