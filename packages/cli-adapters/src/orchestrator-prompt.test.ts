import { describe, expect, it } from "vitest"
import type { CliKind } from "@jingler/core"
import { orchestratorNote } from "./orchestrator-prompt.js"

/**
 * The rule these cover: the orchestrator is a role, not a personality. Its voice
 * must read the same whoever is behind it (the old `adhdNote` split made Opus
 * and Codex sound different), it must tell the agent to act directly on quick
 * work and hand large work off, and it must never re-open plan approval — the
 * scripted "step X of Y, approve again?" loop this replaces.
 */

const HARNESSES: ReadonlyArray<CliKind> = ["claude", "codex", "opencode", "cursor"]

describe("orchestratorNote", () => {
  it("returns the same string for every harness", () => {
    // Takes no `cli` argument on purpose — the note is byte-identical by
    // construction. Assert it anyway so a future `cli` branch fails loudly.
    const notes = HARNESSES.map(() => orchestratorNote())
    for (const note of notes) expect(note).toBe(notes[0])
  })

  it("directs the agent to act directly on quick work and hand large work to workers", () => {
    const note = orchestratorNote().toLowerCase()
    expect(note).toContain("just do it")
    expect(note).toContain("worker")
    expect(note).toMatch(/hand/)
  })

  it("forbids re-requesting plan approval after the first plan", () => {
    const note = orchestratorNote().toLowerCase()
    expect(note).toContain("approved at most once")
    expect(note).toContain("never")
  })

  it("carries no progress-counter phrasing and names no skill", () => {
    const note = orchestratorNote()
    // No "step X of Y" scaffolding — the exact scripting we are removing.
    expect(note).not.toMatch(/step\s+\d+\s+of\s+\d+/i)
    expect(note.toLowerCase()).not.toContain("step ")
    // Naming a skill is a silent no-op on every harness but Claude, so the
    // shared note must not reference one.
    expect(note).not.toContain("skill:")
    expect(note).not.toContain("i-have-adhd")
  })
})
