import { describe, expect, it } from "vitest"
import {
  consolidateObservation,
  currentObservations
} from "./consolidation.js"

const project = { kind: "project" as const, id: "project-a" }

describe("observation consolidation", () => {
  it("refines same-scope evidence without losing history", () => {
    const first = consolidateObservation([], {
      scope: project,
      key: "retry-policy",
      text: "Retries use bounded jitter.",
      evidenceId: "revision:retry:1",
      confidence: 0.7,
      createdAt: "2026-08-20T09:00:00.000Z"
    })
    const second = consolidateObservation([first], {
      scope: project,
      key: "retry-policy",
      text: "Retries use the shared bounded-jitter helper.",
      evidenceId: "revision:retry:2",
      confidence: 0.9,
      createdAt: "2026-08-21T09:00:00.000Z"
    })

    expect(second.version).toBe(2)
    expect(second.supersedesId).toBe(first.id)
    expect(second.evidenceIds).toEqual(["revision:retry:1", "revision:retry:2"])
    expect(currentObservations([first, second], project)).toEqual([second])
  })

  it("returns the current observation unchanged when evidence is replayed", () => {
    const first = consolidateObservation([], {
      scope: project,
      key: "retry-policy",
      text: "Retries use bounded jitter.",
      evidenceId: "revision:retry:1",
      confidence: 0.7,
      createdAt: "2026-08-20T09:00:00.000Z"
    })
    const replay = consolidateObservation([first], {
      scope: project,
      key: "retry-policy",
      text: "A retried request must not rewrite history.",
      evidenceId: "revision:retry:1",
      confidence: 1,
      createdAt: "2026-08-21T09:00:00.000Z"
    })

    expect(replay).toBe(first)
    expect(replay.version).toBe(1)
  })

  it("never combines evidence across scopes", () => {
    const projectA = consolidateObservation([], {
      scope: project,
      key: "deploy",
      text: "Project A deploys from main.",
      evidenceId: "revision:a",
      confidence: 1,
      createdAt: "2026-08-20T09:00:00.000Z"
    })
    const projectB = consolidateObservation([projectA], {
      scope: { kind: "project", id: "project-b" },
      key: "deploy",
      text: "Project B deploys from release.",
      evidenceId: "revision:b",
      confidence: 1,
      createdAt: "2026-08-20T09:00:00.000Z"
    })

    expect(projectB.version).toBe(1)
    expect(projectB.evidenceIds).toEqual(["revision:b"])
    expect(projectB.supersedesId).toBeUndefined()
  })
})
