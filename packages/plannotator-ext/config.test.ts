import { afterEach, describe, expect, it, vi } from "vitest";
import { loadPlannotatorConfig } from "./config.js";

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
