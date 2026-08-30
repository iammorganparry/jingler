import { describe, expect, it } from "vitest"
import {
  composeTurnPrompt,
  isSkillInvocation,
  isSlashCommand,
  leadsWithCommand,
  managedToolsNote,
  planPointerNote,
  researchFirstNote
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

describe("isSkillInvocation", () => {
  it("recognises explicit skill tokens without treating paths as skills", () => {
    expect(isSkillInvocation("$babysit-pr get it to main")).toBe(true)
    expect(isSkillInvocation("/Users/morgan/repo")).toBe(false)
  })
})

describe("leadsWithCommand", () => {
  it("keeps pi commands and skills ahead of injected context", () => {
    expect(leadsWithCommand("$deploy now")).toBe(true)
    expect(leadsWithCommand("/plan")).toBe(true)
    expect(leadsWithCommand("explain /plan")).toBe(false)
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

  it("places managed tool precedence before interaction protocols", () => {
    expect(
      composeTurnPrompt("browse", { tools: "TOOLS", ask: "ASK" }, { leadWithText: false })
    ).toBe("TOOLS\n\nASK\n\nbrowse")
    expect(managedToolsNote()).toContain("jingler-browser")
    expect(managedToolsNote()).toContain("authenticated `gh` CLI")
    expect(managedToolsNote()).toContain("OpenConnector")
  })

  it("places research-first between tools and the ask protocol", () => {
    expect(
      composeTurnPrompt(
        "integrate",
        { tools: "TOOLS", research: "RESEARCH", ask: "ASK" },
        { leadWithText: false }
      )
    ).toBe("TOOLS\n\nRESEARCH\n\nASK\n\nintegrate")
  })

  it("tells the agent its trained integration knowledge is stale and to research current docs first", () => {
    const note = researchFirstNote()
    // The failure mode this exists for: implementing a vendor flow (e.g. a
    // Clerk invite flow) from memory instead of the vendor's current guide.
    expect(note).toContain("<research-first>")
    expect(note).toContain("Never assume")
    expect(note).toContain("Web-search")
    expect(note).toContain("installed package version")
    expect(note).toContain("cite the guide")
    // Scoped: repo-local work is exempt, so every refactor is not taxed.
    expect(note).toContain("repo-local")
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
