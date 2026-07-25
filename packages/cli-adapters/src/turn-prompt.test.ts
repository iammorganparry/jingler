import { describe, expect, it } from "vitest"
import {
  composeTurnPrompt,
  isCodexSkillInvocation,
  isSlashCommand,
  leadsWithCommand,
  planPointerNote
} from "./turn-prompt.js"

/**
 * How a turn's prompt is put together — the ordering, and the one exception to it.
 *
 * Worth its own suite because the exception is a bug that shipped: a harness only
 * expands a slash command when it leads the message, so prefixing a compaction
 * primer turned `/babysit-pr …` into prose and the turn came back with nothing to
 * say. That was previously only reachable by running a scripted turn against a
 * compacted session.
 */

describe("isSlashCommand", () => {
  it("recognises a command, and does not mistake a path for one", () => {
    expect(isSlashCommand("/plan")).toBe(true)
    expect(isSlashCommand("/babysit-pr get it to main")).toBe(true)
    expect(isSlashCommand("  /plan")).toBe(true)
    // Deliberately narrow — these are the false positives that would demote a
    // perfectly ordinary message.
    expect(isSlashCommand("/Users/morgan/repo")).toBe(false)
    expect(isSlashCommand("/")).toBe(false)
    expect(isSlashCommand("what does / mean")).toBe(false)
  })
})

describe("isCodexSkillInvocation", () => {
  it("recognises explicit Codex skill tokens without treating paths as skills", () => {
    expect(isCodexSkillInvocation("$babysit-pr get it to main")).toBe(true)
    expect(isCodexSkillInvocation("/Users/morgan/repo")).toBe(false)
  })
})

describe("leadsWithCommand", () => {
  it("asks the harness, not just the text", () => {
    // `$skill` is Codex syntax. Treating it as a command elsewhere would push the
    // notes behind a message that never needed to lead.
    expect(leadsWithCommand("codex", "$deploy now")).toBe(true)
    expect(leadsWithCommand("claude", "$deploy now")).toBe(false)
    // Slash commands lead on every harness.
    expect(leadsWithCommand("claude", "/plan")).toBe(true)
    expect(leadsWithCommand("codex", "/plan")).toBe(true)
  })
})

describe("composeTurnPrompt", () => {
  const notes = { primer: "PRIMER", planPointer: "PLAN", adhd: "ADHD", ask: "ASK" }

  it("puts the notes in front of an ordinary message, in a fixed order", () => {
    expect(composeTurnPrompt("do the thing", notes, { leadWithText: false })).toBe(
      "PRIMER\n\nPLAN\n\nADHD\n\nASK\n\ndo the thing"
    )
  })

  it("puts a command FIRST, with the notes after it", () => {
    // The bug this exists for: anything before `/babysit-pr` demotes it to prose.
    expect(composeTurnPrompt("/babysit-pr", notes, { leadWithText: true })).toBe(
      "/babysit-pr\n\nPRIMER\n\nPLAN\n\nADHD\n\nASK"
    )
  })

  it("leaves no trailing blank line when the message leads", () => {
    // Each note ends in a blank line; the last one would otherwise dangle.
    const composed = composeTurnPrompt("/plan", { ask: "ASK" }, { leadWithText: true })
    expect(composed).toBe("/plan\n\nASK")
    expect(composed.endsWith("\n")).toBe(false)
  })

  it("skips notes that do not apply, without leaving gaps", () => {
    expect(
      composeTurnPrompt("hello", { primer: null, planPointer: "PLAN", adhd: undefined, ask: "" }, {
        leadWithText: false
      })
    ).toBe("PLAN\n\nhello")
  })

  it("returns the message untouched when there are no notes at all", () => {
    expect(composeTurnPrompt("hello", {}, { leadWithText: false })).toBe("hello")
    expect(composeTurnPrompt("/plan", {}, { leadWithText: true })).toBe("/plan")
  })

  it("keeps the plan protocol last, closest to the message", () => {
    // Order matters: the protocol note tells the harness how to end its reply, so
    // it sits nearest the instruction it qualifies.
    expect(
      composeTurnPrompt("x", { primer: "P", planProtocol: "PROTO" }, { leadWithText: false })
    ).toBe("P\n\nPROTO\n\nx")
  })
})

describe("planPointerNote", () => {
  it("names the worktree as the project root, and the plan as outside it", () => {
    const note = planPointerNote("/wt/session", ["plan-1.md"])
    // Both jobs of this note, each guarding a real failure: an agent that `cd`s out
    // of its worktree corrupts the wrong tree, and one that cannot find the plan
    // ignores it.
    expect(note).toContain("/wt/session")
    expect(note).toContain("- plan-1.md")
    expect(note).toContain("is NOT the repo")
    expect(note.startsWith("<session-context>")).toBe(true)
    expect(note.endsWith("</session-context>")).toBe(true)
  })

  it("lists every saved plan", () => {
    const note = planPointerNote("/wt", ["a.md", "b.md"])
    expect(note).toContain("- a.md")
    expect(note).toContain("- b.md")
  })
})
