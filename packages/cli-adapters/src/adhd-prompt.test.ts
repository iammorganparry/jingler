import { describe, expect, it } from "vitest"
import { adhdNote } from "./adhd-prompt.js"

/**
 * ADHD mode is a per-turn prompt prefix, but its rules apply only to the final
 * completion summary. Claude is pointed at the operator's skill (the source of
 * truth they can edit without a release); every other harness cannot see
 * `~/.claude/skills`, so the rules have to travel inline.
 */
describe("adhdNote", () => {
  it("points Claude at the i-have-adhd skill", () => {
    const note = adhdNote("claude")
    expect(note).toContain("i-have-adhd:i-have-adhd")
  })

  it("carries the rules inline for Claude too, as a fallback", () => {
    expect(adhdNote("claude")).toContain("First line is an action")
  })

  it("limits the format to a finished task's completion summary", () => {
    for (const cli of ["claude", "codex", "cursor"] as const) {
      const note = adhdNote(cli)
      expect(note).toContain("only")
      expect(note).toContain("final completion summary")
      expect(note).toContain("working updates")
      expect(note).toContain("planning")
      expect(note).toContain("questions")
    }
    expect(adhdNote("claude")).not.toContain("shape this entire reply")
    expect(adhdNote("claude")).not.toContain("before replying")
  })

  it("never names a skill for harnesses that cannot see one", () => {
    for (const cli of ["codex", "cursor"] as const) {
      const note = adhdNote(cli)
      expect(note).not.toContain("i-have-adhd")
      expect(note).toContain("First line is an action")
      expect(note).toContain("End with ONE next action")
    }
  })
})
