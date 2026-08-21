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
    expect(first.definitionVersion).toBe(definition.definitionVersion)
    expect(second.version).toBe(2)
    expect(second.id).not.toBe(first.id)
  })

  it("does not fall back to unrelated observations for an unmatched query", () => {
    const definition = defineMentalModel({
      id: "model:security",
      name: "Security policy",
      scope,
      sourceQuery: "security encryption",
      maxTokens: 100,
      refreshAfterConsolidation: false,
      publication: "published",
      createdAt: "2026-08-20T09:00:00.000Z"
    })
    const revision = refreshMentalModel(
      definition,
      [observation("payroll", "Payroll closes on Friday.")],
      [],
      "2026-08-20T10:00:00.000Z"
    )

    expect(revision.content).toBe("")
    expect(revision.evidenceObservationIds).toEqual([])
  })

  it("cites only observations represented inside the content budget", () => {
    const definition = defineMentalModel({
      id: "model:retry-budget",
      name: "Retry guidance",
      scope,
      sourceQuery: "retry",
      maxTokens: 4,
      refreshAfterConsolidation: false,
      publication: "published",
      createdAt: "2026-08-20T09:00:00.000Z"
    })
    const revision = refreshMentalModel(definition, [
      observation("retry-one", "The first retry observation is deliberately long."),
      observation("retry-two", "The second retry observation must be excluded.")
    ], [], "2026-08-20T10:00:00.000Z")

    expect(revision.content.length).toBeLessThanOrEqual(16)
    expect(revision.evidenceObservationIds).toEqual(["retry-one"])
    expect(revision.content).not.toContain("second")
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
