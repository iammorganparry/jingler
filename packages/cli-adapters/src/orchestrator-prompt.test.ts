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

  it("uses concrete direct and delegation signals instead of a size shortcut", () => {
    const note = orchestratorNote().toLowerCase()
    expect(note).toContain("one bounded outcome")
    expect(note).toContain("delegation should earn its overhead")
    expect(note).toContain("independent components")
    expect(note).toContain("specialist")
    expect(note).toContain("verification-heavy")
    expect(note).toContain("changes an approved plan")
    expect(note).not.toContain("quick or")
    expect(note).not.toContain("larger or")
  })

  it("retains native capabilities and makes the orchestrator own delegated outcomes", () => {
    const note = orchestratorNote().toLowerCase()
    for (const capability of [
      "editing",
      "commands",
      "skills",
      "git/github",
      "participant steering",
      "communication"
    ]) {
      expect(note).toContain(capability)
    }
    expect(note).toContain("handoff transfers execution, not responsibility")
    expect(note).toContain("monitor worker")
    expect(note).toContain("retry only failed/changed components")
    expect(note).toContain("integrate the result")
    expect(note).toContain("report the final outcome yourself")
  })

  it("forbids re-requesting plan approval after the first plan", () => {
    const note = orchestratorNote().toLowerCase()
    expect(note).toContain("approved at most once")
    expect(note).toContain("never")
  })

  it("uses the canonical plan for progress instead of narrating it", () => {
    const note = orchestratorNote().toLowerCase()
    expect(note).toContain("canonical plan as the progress interface")
    expect(note).toContain("update the plan instead of repeating it in chat")
    expect(note).toContain("required decision or blocker")
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
