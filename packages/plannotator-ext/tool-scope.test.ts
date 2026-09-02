import { mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { resolvePhaseProfile, type PlannotatorConfig } from "./config.js";
import { applyPhaseTools, isPlanWritePathAllowed, releasePhaseTools } from "./tool-scope.js";

describe("applyPhaseTools", () => {
	it("adds configured tools not already active and records them as additions", () => {
		const selection = applyPhaseTools(["read", "grep"], [], ["write", "grep"]);
		expect(selection.activeTools).toEqual(["read", "grep", "write"]);
		expect(selection.addedTools).toEqual(["write"]);
	});

	it("swaps a previous phase's additions for the next phase's", () => {
		const planning = applyPhaseTools(["read", "write", "edit"], ["write", "edit"], ["workspace_edit"]);
		expect(planning.activeTools).toEqual(["read", "workspace_edit"]);
		expect(planning.addedTools).toEqual(["workspace_edit"]);
	});

	// The regression this pins: plan mode seeds native write/edit into the
	// session's BASE toolset (they are not phase additions), so the executing
	// swap used to carry them straight into execution — where they bypass
	// mutation tracking. removeTools strips base tools at phase entry.
	it("removeTools strips base tools the phase must not have", () => {
		const selection = applyPhaseTools(
			["read", "write", "edit", "plannotator_update_plan"],
			[],
			["workspace_edit", "workspace_write"],
			["write", "edit"],
		);
		expect(selection.activeTools).toEqual([
			"read",
			"plannotator_update_plan",
			"workspace_edit",
			"workspace_write",
		]);
		expect(selection.addedTools).toEqual(["workspace_edit", "workspace_write"]);
	});

	it("removeTools wins over a conflicting configured addition", () => {
		const selection = applyPhaseTools(["read"], [], ["edit"], ["edit"]);
		expect(selection.activeTools).toEqual(["read"]);
		expect(selection.addedTools).toEqual([]);
	});

	it("released additions do not resurrect removed base tools", () => {
		const executing = applyPhaseTools(
			["read", "write", "edit"],
			[],
			["workspace_edit"],
			["write", "edit"],
		);
		const idle = releasePhaseTools(executing.activeTools, executing.addedTools);
		expect(idle).toEqual(["read"]);
	});
});

describe("planning writes", () => {
	it("allows plan markdown but not source files, traversal, or symlink escapes", async () => {
		const root = await mkdtemp(join(tmpdir(), "plannotator-plan-root-"));
		const outside = await mkdtemp(join(tmpdir(), "plannotator-plan-outside-"));
		try {
			await symlink(outside, join(root, "escape"));
			await symlink(join(outside, "new.md"), join(root, "DANGLING.md"));
			expect(isPlanWritePathAllowed("PLAN.md", root)).toBe(true);
			expect(isPlanWritePathAllowed("plans/auth.mdx", root)).toBe(true);
			expect(isPlanWritePathAllowed("src/auth.ts", root)).toBe(false);
			expect(isPlanWritePathAllowed("../PLAN.md", root)).toBe(false);
			expect(isPlanWritePathAllowed("escape/PLAN.md", root)).toBe(false);
			expect(isPlanWritePathAllowed("DANGLING.md", root)).toBe(false);
		} finally {
			await Promise.all([
				rm(root, { recursive: true, force: true }),
				rm(outside, { recursive: true, force: true }),
			]);
		}
	});
});

describe("resolvePhaseProfile removeTools", () => {
	it("resolves a phase-level removeTools list", () => {
		const config: PlannotatorConfig = {
			phases: { executing: { removeTools: ["write", "edit"] } },
		};
		expect(resolvePhaseProfile(config, "executing").removeTools).toEqual(["write", "edit"]);
		expect(resolvePhaseProfile(config, "planning").removeTools).toBeUndefined();
	});

	it("a phase null clears an inherited defaults removeTools", () => {
		const config: PlannotatorConfig = {
			defaults: { removeTools: ["write"] },
			phases: { executing: { removeTools: null } },
		};
		expect(resolvePhaseProfile(config, "executing").removeTools).toEqual([]);
		expect(resolvePhaseProfile(config, "planning").removeTools).toEqual(["write"]);
	});
});
