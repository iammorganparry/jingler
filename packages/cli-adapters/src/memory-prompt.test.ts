import { describe, expect, it } from "vitest";
import { memoryPrompt } from "./memory-prompt.js";

describe("memoryPrompt", () => {
  it("requires bounded silent reflection before a non-trivial turn settles", () => {
    const prompt = memoryPrompt();

    expect(prompt).toContain("Before ending each non-trivial settled turn");
    expect(prompt).toContain("at most three standalone candidates");
    expect(prompt).toContain("Submit no more than three memory_propose calls");
    expect(prompt).toContain("silently reflect");
    expect(prompt).toContain("never delay or alter the user-visible answer");
  });

  it("defines durable learning and the required privacy exclusions", () => {
    const prompt = memoryPrompt();

    for (const durable of [
      "settled decision with its reason",
      "stable convention or preference",
      "non-obvious gotcha with its cause",
      "hard-won verified finding",
    ]) {
      expect(prompt).toContain(durable);
    }
    for (const excluded of [
      "progress narration",
      "facts already documented",
      "temporary paths",
      "secrets or credential-shaped content",
      "personal, identifying, or sensitive data",
      "claims later corrected or superseded",
      "low-confidence inferences",
    ]) {
      expect(prompt).toContain(excluded);
    }
  });

  it("deduplicates against accepted pages before choosing update or new", () => {
    const prompt = memoryPrompt();

    expect(prompt).toContain("run a narrow memory_search");
    expect(prompt).toContain("memory_read every plausible accepted-page match");
    expect(prompt).toContain(
      "drop the candidate when the accepted page already says it",
    );
    expect(prompt).toContain(
      "Only use baseRevisionId 'new' after this duplicate check",
    );
    expect(prompt).toContain("Poll memory_workflow_status");
  });

  it.each([
    {
      case: "durable positive",
      evidence:
        "KEEP an undocumented, verified root cause and reusable fix with its reason",
    },
    {
      case: "no-op progress negative",
      evidence:
        "DROP an implementation-status update even when the work succeeded",
    },
    {
      case: "documented no-op negative",
      evidence: "DROP a fact found in code or docs",
    },
    {
      case: "corrected claim",
      evidence:
        "KEEP the final verified decision while dropping an earlier claim that the turn corrected",
    },
    {
      case: "accepted-memory duplicate",
      evidence:
        "DROP a candidate when search plus accepted-page read shows the same knowledge",
    },
    {
      case: "privacy exclusion",
      evidence:
        "DROP any candidate containing a credential-shaped value or personal data",
    },
  ])("includes an explicit $case case", ({ evidence }) => {
    expect(memoryPrompt()).toContain(evidence);
  });

  it("bounds a turn with many valid candidates to three proposals", () => {
    const prompt = memoryPrompt();

    expect(prompt).toContain("when more than three candidates qualify");
    expect(prompt).toContain(
      "choose only the three most durable and broadly reusable",
    );
    expect(
      prompt.match(/no more than three memory_propose calls/g),
    ).toHaveLength(1);
  });

  it("keeps the rubric in control while disabling unsolicited reflection proposals", () => {
    const prompt = memoryPrompt({ reflectionEnabled: false });

    expect(prompt).toContain("Before ending each non-trivial settled turn");
    expect(prompt).toContain("reflection control arm");
    expect(prompt).toContain("do not proactively call memory_propose");
  });
});
