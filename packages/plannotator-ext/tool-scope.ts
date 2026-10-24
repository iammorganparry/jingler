import { lstatSync, realpathSync } from "node:fs";
import { basename, dirname, extname, isAbsolute, relative, resolve, sep } from "node:path";

export type Phase = "idle" | "planning" | "executing";

export const PLAN_SUBMIT_TOOL = "plannotator_submit_plan";
export const PLAN_UPDATE_TOOL = "plannotator_update_plan";

const ALLOWED_PLAN_EXTENSIONS = new Set<string>([".md", ".mdx"]);

export function applyPhaseTools(
	activeTools: readonly string[],
	previouslyAddedTools: readonly string[],
	configuredTools: readonly string[],
	removeTools: readonly string[] = [],
): { activeTools: string[]; addedTools: string[] } {
	const previousAdditions = new Set(previouslyAddedTools);
	const removed = new Set(removeTools);
	const baseTools = activeTools.filter(
		(tool) => !previousAdditions.has(tool) && !removed.has(tool),
	);
	const baseToolSet = new Set(baseTools);
	const addedTools = [...new Set(configuredTools)].filter(
		(tool) => !baseToolSet.has(tool) && !removed.has(tool),
	);

	return {
		activeTools: [...baseTools, ...addedTools],
		addedTools,
	};
}

export function releasePhaseTools(
	activeTools: readonly string[],
	addedTools: readonly string[],
): string[] {
	const additions = new Set(addedTools);
	return activeTools.filter((tool) => !additions.has(tool));
}

// A plan file is `plans/**` or a file whose name starts a word with "plan"
// (PLAN.md, auth-plan.md). AGENTS.md, CLAUDE.md and README.md never match.
const PLAN_FILE_NAME = /(^|[^a-z])plan/i;

// Used by both the planning-phase write gate and plannotator_submit_plan.
// Path must resolve inside cwd (no traversal, no absolute escape), end in a
// permitted markdown extension, and look like a plan file.
export function isPlanWritePathAllowed(inputPath: string, cwd: string): boolean {
	if (!isWorkspaceMarkdownPath(inputPath, cwd)) return false;
	const rel = relative(cwd, resolve(cwd, inputPath));
	return rel.split(sep).includes("plans") || PLAN_FILE_NAME.test(basename(rel));
}

// Any Markdown file inside cwd; enough to adopt a plan for reading outside plan mode.
export function isWorkspaceMarkdownPath(inputPath: string, cwd: string): boolean {
	if (!inputPath) return false;
	const targetAbs = resolve(cwd, inputPath);
	const ext = extname(targetAbs).toLowerCase();
	if (!ALLOWED_PLAN_EXTENSIONS.has(ext)) return false;

	try {
		const root = realpathSync(cwd);
		let existing = targetAbs;
		while (true) {
			try {
				lstatSync(existing);
				break;
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") return false;
				const parent = dirname(existing);
				if (parent === existing) return false;
				existing = parent;
			}
		}
		const rel = relative(root, realpathSync(existing));
		return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
	} catch {
		return false;
	}
}
