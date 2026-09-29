import { afterEach, describe, expect, it, vi } from "vitest";
import { loadPlannotatorConfig } from "./config.js";
import bundled from "./plannotator.json" with { type: "json" };
import { parsePlanMarkdown } from "./plan-parse.ts";
import { validatePlanMarkdown } from "./plan-validation.ts";

const { files } = vi.hoisted(() => ({ files: new Map<string, string>() }));
vi.mock("node:fs", () => ({
  existsSync: () => true,
  readFileSync: (path: string) => files.get(path) ?? "{}",
}));
afterEach(() => files.clear());

describe("project config normalization", () => {
  it("keeps valid phase overrides and reports all obsolete prompt scopes", () => {
    files.set("/project/.pi/plannotator.json", JSON.stringify({
      executionMode: "external",
      defaults: { instructions: "Plan carefully", systemPrompt: "obsolete" },
      phases: {
        planning: { instructions: "Inspect first", systemPrompt: null },
        executing: { instructions: null, systemPrompt: "obsolete" },
        reviewing: [],
      },
    }));
    const loaded = loadPlannotatorConfig("/project", { projectTrusted: true });
    expect(loaded.config.executionMode).toBe("external");
    expect(loaded.config.defaults?.instructions).toBe("Plan carefully");
    expect(loaded.config.phases?.planning?.instructions).toBe("Inspect first");
    expect(loaded.config.phases?.executing?.instructions).toBeNull();
    expect(loaded.warnings).toEqual([
      expect.stringContaining('under defaults, phases.planning, phases.executing'),
    ]);
  });

  it("ignores untrusted config and rejects unknown modes without losing valid defaults", () => {
    files.set("/project/.pi/plannotator.json", JSON.stringify({
      executionMode: "surprise",
      defaults: { instructions: "Project instructions" },
      phases: null,
    }));
    expect(loadPlannotatorConfig("/project", { projectTrusted: false })).toEqual({ config: {
      executionMode: undefined, defaults: undefined, phases: undefined,
    }, warnings: [] });
    const loaded = loadPlannotatorConfig("/project", { projectTrusted: true });
    expect(loaded.config.executionMode).toBeUndefined();
    expect(loaded.config.defaults?.instructions).toBe("Project instructions");
    expect(loaded.warnings).toEqual([expect.stringContaining('Ignoring unknown executionMode "surprise"')]);
  });
});

describe("bundled planning instructions", () => {
  const instructions = bundled.phases.planning.instructions;
  const example = /````md\n([\s\S]*?)\n````/.exec(instructions)?.[1] ?? "";

  it("planning instructions require concise structured plans", () => {
    expect(instructions).toContain("Keep the plan scan-first");
    expect(instructions).toContain("Up to three concrete implementation choices");
    expect(instructions).toContain("Do not add separate global file, reuse, approach, or verification sections");
    expect(instructions).toContain("For every staged plan, include one top-level Mermaid flow");
    expect(instructions).not.toContain("Skip diagrams for trivial");
    expect(instructions).toContain("%% link <nodeId> file:");
    expect(instructions).toContain("diff path=<repo-relative path>");
    expect(instructions).toContain("test[unit|integration|e2e|manual]");
    expect(instructions).toContain("## Test strategy");

    // The example the prompt teaches must pass the same gate submission enforces.
    expect(example).not.toBe("");
    expect(validatePlanMarkdown(example)).toEqual([]);
    const parsed = parsePlanMarkdown(example);
    expect(parsed.stages[0]?.changes).toEqual([
      expect.objectContaining({ path: "path/to/file.ts" }),
    ]);
    expect(parsed.stages[0]?.acceptance[0]?.testReferences?.[0]?.kind).toBe("unit");
    expect(parsed.sections.some((section) =>
      section.blocks.some((block) => block.kind === "diagram" && block.source.includes("%% link change stage:stable-stage-id")),
    )).toBe(true);
  });

  it("the example would be rejected without its test strategy", () => {
    const withoutStrategy = example.replace(/## Test strategy[\s\S]*$/, "");
    expect(validatePlanMarkdown(withoutStrategy)).toContain('Plan needs a "## Test strategy" section.');
  });
});
