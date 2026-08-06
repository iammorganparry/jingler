import { describe, expect, it } from "vitest"
import type { Message } from "./conversation.js"
import {
  UNTITLED_SESSION,
  buildTitlePrompt,
  cleanBranchSlug,
  cleanSemanticBranchProposal,
  cleanTitle,
  fallbackTitle,
  semanticBranchName,
  semanticBranchProposalFromName
} from "./session-title.js"

/**
 * The title helpers are the deterministic core of auto-naming — both the LLM
 * output and the no-LLM fallback funnel through `cleanTitle`, so these guard the
 * shape of every session name a user sees.
 */

const msg = (role: "user" | "assistant", text: string): Message => ({
  id: `m_${role}`,
  role,
  parts: text.length > 0 ? [{ _tag: "Text", text }] : [],
  streaming: false,
  createdAt: "2026-07-13T00:00:00.000Z"
})

describe("cleanTitle", () => {
  it("collapses newlines/whitespace to a single line", () => {
    expect(cleanTitle("Refactor   the\nauth   flow")).toBe("Refactor the auth flow")
  })

  it("strips surrounding quotes and a trailing period", () => {
    expect(cleanTitle('"Add a Token Store."')).toBe("Add a Token Store")
    expect(cleanTitle("“Fix login bug”")).toBe("Fix login bug")
  })

  it("clamps to maxLen on a word boundary with an ellipsis", () => {
    const out = cleanTitle("one two three four five six seven eight nine ten", 20)
    expect(out.length).toBeLessThanOrEqual(21) // 20 + ellipsis
    expect(out.endsWith("…")).toBe(true)
    expect(out).not.toContain("  ")
  })

  it("falls back to UNTITLED_SESSION on empty/whitespace input", () => {
    expect(cleanTitle("   ")).toBe(UNTITLED_SESSION)
    expect(cleanTitle('""')).toBe(UNTITLED_SESSION)
  })
})

describe("fallbackTitle", () => {
  it("derives from the FIRST user message (not the assistant)", () => {
    const messages = [
      msg("user", "Help me add rate limiting to the API"),
      msg("assistant", "Sure, I'll start by reading the middleware.")
    ]
    expect(fallbackTitle(messages)).toBe("Help me add rate limiting to the API")
  })

  it("returns UNTITLED_SESSION when there is no user text", () => {
    expect(fallbackTitle([])).toBe(UNTITLED_SESSION)
    expect(fallbackTitle([msg("assistant", "hi")])).toBe(UNTITLED_SESSION)
  })
})

describe("buildTitlePrompt", () => {
  it("includes the user's request and instructs for a terse title", () => {
    const prompt = buildTitlePrompt([msg("user", "Migrate sessions to a TokenStore")])
    expect(prompt).toContain("Migrate sessions to a TokenStore")
    expect(prompt.toLowerCase()).toContain("3-6 word title")
    expect(prompt).toMatch(/ONLY JSON/)
  })

  it("is deterministic for a fixed transcript", () => {
    const messages = [msg("user", "Fix the flaky test"), msg("assistant", "Looking at the retries.")]
    expect(buildTitlePrompt(messages)).toBe(buildTitlePrompt(messages))
  })
})

describe("semantic branch metadata", () => {
  it("normalizes model slugs and retains an allowed type", () => {
    const proposal = cleanSemanticBranchProposal(
      { type: "fix", slug: " Review routing / race!!! " },
      "fallback"
    )
    expect(proposal).toStrictEqual({ type: "fix", slug: "review-routing-race" })
    expect(semanticBranchName(proposal)).toBe("fix/review-routing-race")
    expect(semanticBranchProposalFromName("fix/review-routing-race")).toStrictEqual(proposal)
  })

  it.each([
    { type: "../../main", slug: "steal-session" },
    { type: "fix", slug: "../../main; echo owned" },
    { type: "fix", slug: "HEAD" },
    { type: "fix", slug: "x".repeat(81) },
    { type: "fix", slug: "///" },
    { type: "fix", slug: "" }
  ])("uses the task-derived chore fallback for invalid metadata %#", (raw) => {
    expect(cleanSemanticBranchProposal(raw, "Repair auth callback"))
      .toStrictEqual({ type: "chore", slug: "repair-auth-callback" })
  })

  it("normalizes harmless type casing and bounds deterministic fallbacks", () => {
    expect(cleanSemanticBranchProposal({ type: " Fix ", slug: "Callback State" }, "fallback"))
      .toStrictEqual({ type: "fix", slug: "callback-state" })
    expect(cleanBranchSlug("x".repeat(200))).toHaveLength(80)
    expect(cleanSemanticBranchProposal(null, "x".repeat(200)).slug).toHaveLength(80)
    expect(semanticBranchProposalFromName("fix/HEAD")).toBeNull()
    expect(semanticBranchProposalFromName("topic/callback-state")).toBeNull()
  })
})
