/**
 * Structured plan-markdown parser — Jingler's scratchpad convention.
 *
 * The plan file stays ordinary agent-editable Markdown; this parser lifts a
 * light structure out of it for the host's rich plan surface:
 *
 * - optional YAML frontmatter: `title:` / `revision:`
 * - content before the first `## ` heading → overview section blocks (TL;DR
 *   first, prose/lists/code/mermaid; a leading `# ` heading names the plan)
 * - when any `##` heading has `<!-- id: ... -->`, only tagged headings are
 *   stages and untagged `##` headings are document sections
 * - legacy plans without tagged headings keep treating every `##` as a stage
 * - the first paragraph under a stage → its intent; later paragraphs → notes
 * - `### Approach` bullets (or the stage's first plain bullet list) → approach
 * - checkboxes → tasks; indentation nests one level of subtasks;
 *   `[ ]` pending, `[x]` completed, `[~]` in-progress, `[-]` blocked
 * - `### Acceptance` checkboxes → acceptance criteria; a
 *   `(test: path::case, case)` suffix becomes test references
 * - `### Files` entries `` `path` — A|M|D `` → the stage's file plan
 * - `> complexity: low|medium|high` and `> depends: id, id` → stage metadata
 * - ```mermaid fences → diagrams (stage-level, or overview blocks)
 * - ```diff path=<repo path> fences → proposed changes (stage or section)
 * - `(test[unit|integration|e2e|manual]: …)` tags a test reference's kind
 *
 * Every checkbox, at any indent, gets a flat 1-based `step` in document order —
 * the SAME numbering `parseChecklist` produces and `[DONE:n]` markers target.
 * Plain flat checklists parse exactly as before: one stage-less checklist,
 * no sections, and the host falls back to its flat projection.
 */
import { scanChecklist, type ChecklistItem } from "./generated/checklist.ts";

export type PlanTaskStatus = "pending" | "in-progress" | "completed" | "blocked";

export interface PlanStageSubtask {
	step: number;
	text: string;
	status: PlanTaskStatus;
}

export interface PlanStageTask extends PlanStageSubtask {
	subtasks: PlanStageSubtask[];
}

export type PlanTestKind = "unit" | "integration" | "e2e" | "manual";

export interface PlanTestReference {
	path: string;
	cases: string[];
	kind?: PlanTestKind;
}

export interface PlanAcceptanceItem {
	step: number;
	text: string;
	status: "pending" | "passed";
	testReferences?: PlanTestReference[];
}

/** A proposed unified diff for one repository-relative file. */
export interface PlanChange {
	path: string;
	patch: string;
}

export interface PlanStageFile {
	path: string;
	change: "A" | "M" | "D";
}

export interface ParsedPlanStage {
	id: string;
	title: string;
	intent: string;
	approach: string[];
	tasks: PlanStageTask[];
	acceptance: PlanAcceptanceItem[];
	files: PlanStageFile[];
	diagrams: string[];
	changes: PlanChange[];
	notes: string[];
	complexity?: "low" | "medium" | "high";
	dependencies?: string[];
}

export type PlanSectionBlock =
	| { kind: "prose"; text: string }
	| { kind: "heading"; level: 2 | 3 | 4; text: string }
	| { kind: "list"; ordered: boolean; items: string[] }
	| { kind: "code"; language?: string; code: string }
	| { kind: "diagram"; source: string }
	| ({ kind: "change" } & PlanChange);

export interface PlanSection {
	title: string | null;
	blocks: PlanSectionBlock[];
}

export interface ParsedPlanMarkdown {
	title: string | null;
	revision: number;
	sections: PlanSection[];
	stages: ParsedPlanStage[];
	/** Flat checklist, identical numbering to `parseChecklist`. */
	checklist: ChecklistItem[];
}

const STAGE_HEADING = /^##\s+(.+?)\s*$/;
const SUB_HEADING = /^###\s+(.+?)\s*$/;
const STAGE_ID_COMMENT = /\s*<!--\s*id:\s*([\w-]+)\s*-->\s*$/;
const BULLET_LINE = /^\s*[-*]\s+(.+)$/;
const ORDERED_LINE = /^\s*\d+[.)]\s+(.+)$/;
const FENCE_LINE = /^```([\w-]*)(?:\s+(.*?))?\s*$/;
const FENCE_PATH = /(?:^|\s)path=(\S+)/;
const FILE_LINE = /^\s*[-*]\s+`([^`]+)`\s*[—-]+\s*([AMD])\s*$/;
const COMPLEXITY_LINE = /^>\s*complexity:\s*(low|medium|high)\s*$/i;
const DEPENDS_LINE = /^>\s*depends:\s*(.+?)\s*$/i;
const TEST_REFERENCE_SUFFIX = /\s*\(test(?:\[(unit|integration|e2e|manual)\])?:\s*([^)]+)\)\s*$/;

const slugOf = (title: string): string => {
	const slug = title
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");
	return slug.length > 0 ? slug : "stage";
};

const taskStatusOf = (mark: string, completed: boolean): PlanTaskStatus => {
	if (completed) return "completed";
	if (mark === "~") return "in-progress";
	if (mark === "-") return "blocked";
	return "pending";
};

const parseTestReferences = (
	text: string,
): { text: string; testReferences?: PlanTestReference[] } => {
	const match = TEST_REFERENCE_SUFFIX.exec(text);
	if (!match) return { text };
	const kind = match[1] as PlanTestKind | undefined;
	const [path, casesText] = match[2].split("::");
	if (!path?.trim()) return { text };
	const cases = (casesText ?? "")
		.split(",")
		.map((candidate) => candidate.trim())
		.filter((candidate) => candidate.length > 0);
	return {
		text: text.slice(0, match.index).trim(),
		testReferences: [{ path: path.trim(), cases, ...(kind === undefined ? {} : { kind }) }],
	};
};

interface Frontmatter {
	title: string | null;
	revision: number;
	bodyStart: number;
}

const parseFrontmatter = (lines: string[]): Frontmatter => {
	if (lines[0]?.trim() !== "---") return { title: null, revision: 1, bodyStart: 0 };
	for (let index = 1; index < lines.length; index++) {
		if (lines[index].trim() === "---") {
			let title: string | null = null;
			let revision = 1;
			for (const line of lines.slice(1, index)) {
				const titleMatch = /^title:\s*(.+?)\s*$/.exec(line);
				if (titleMatch) title = titleMatch[1].replace(/^["']|["']$/g, "");
				const revisionMatch = /^revision:\s*(\d+)\s*$/.exec(line);
				if (revisionMatch) revision = Number(revisionMatch[1]);
			}
			return { title, revision, bodyStart: index + 1 };
		}
	}
	return { title: null, revision: 1, bodyStart: 0 };
};

/** Collector for the overview (pre-stage) blocks. */
class SectionBuilder {
	readonly blocks: PlanSectionBlock[] = [];
	#paragraph: string[] = [];
	#list: { ordered: boolean; items: string[] } | null = null;

	flush(): void {
		if (this.#paragraph.length > 0) {
			this.blocks.push({ kind: "prose", text: this.#paragraph.join("\n") });
			this.#paragraph = [];
		}
		if (this.#list !== null) {
			this.blocks.push({ kind: "list", ...this.#list });
			this.#list = null;
		}
	}

	line(raw: string): void {
		const trimmed = raw.trim();
		if (trimmed.length === 0) {
			this.flush();
			return;
		}
		const heading = SUB_HEADING.exec(raw) ?? /^####\s+(.+?)\s*$/.exec(raw);
		if (heading) {
			this.flush();
			this.blocks.push({
				kind: "heading",
				level: raw.startsWith("####") ? 4 : 3,
				text: heading[1],
			});
			return;
		}
		const ordered = ORDERED_LINE.exec(raw);
		const bullet = BULLET_LINE.exec(raw);
		if (ordered || bullet) {
			const item = (ordered?.[1] ?? bullet?.[1] ?? "").trim();
			const isOrdered = ordered !== null;
			if (this.#list === null || this.#list.ordered !== isOrdered) {
				this.flush();
				this.#list = { ordered: isOrdered, items: [] };
			}
			this.#list.items.push(item);
			return;
		}
		if (this.#list !== null) this.flush();
		this.#paragraph.push(trimmed);
	}

	code(language: string, code: string, path: string | null): void {
		this.flush();
		if (language === "mermaid") this.blocks.push({ kind: "diagram", source: code });
		else if (path !== null) this.blocks.push({ kind: "change", path, patch: code });
		else
			this.blocks.push({
				kind: "code",
				...(language.length > 0 ? { language } : {}),
				code,
			});
	}
}

type StageSubsection = "body" | "approach" | "acceptance" | "files";

class StageBuilder {
	readonly stage: ParsedPlanStage;
	#subsection: StageSubsection = "body";
	#paragraph: string[] = [];
	#sawIntent = false;
	#bodyBullets: string[] = [];

	constructor(heading: string) {
		const idMatch = STAGE_ID_COMMENT.exec(heading);
		const title = idMatch ? heading.slice(0, idMatch.index).trim() : heading.trim();
		this.stage = {
			id: idMatch ? idMatch[1] : slugOf(title),
			title,
			intent: "",
			approach: [],
			tasks: [],
			acceptance: [],
			files: [],
			diagrams: [],
			changes: [],
			notes: [],
		};
	}

	#flushParagraph(): void {
		if (this.#paragraph.length === 0) return;
		const text = this.#paragraph.join("\n");
		this.#paragraph = [];
		if (this.#sawIntent) this.stage.notes.push(text);
		else {
			this.stage.intent = text;
			this.#sawIntent = true;
		}
	}

	finish(): ParsedPlanStage {
		this.#flushParagraph();
		// No explicit `### Approach`: the stage's plain (non-checkbox) bullet
		// list carries the ordered steps.
		if (this.stage.approach.length === 0 && this.#bodyBullets.length > 0) {
			this.stage.approach = this.#bodyBullets;
		}
		return this.stage;
	}

	checkbox(step: number, mark: string, text: string): void {
		this.#flushParagraph();
		const completed = /[xX]/.test(mark);
		if (this.#subsection === "acceptance") {
			const parsed = parseTestReferences(text);
			this.stage.acceptance.push({
				step,
				text: parsed.text,
				status: completed ? "passed" : "pending",
				...(parsed.testReferences === undefined
					? {}
					: { testReferences: parsed.testReferences }),
			});
			return;
		}
		this.stage.tasks.push({
			step,
			text,
			status: taskStatusOf(mark, completed),
			subtasks: [],
		});
	}

	nestedCheckbox(step: number, mark: string, text: string): void {
		const completed = /[xX]/.test(mark);
		if (this.#subsection === "acceptance") {
			this.checkbox(step, mark, text);
			return;
		}
		const parent = this.stage.tasks.at(-1);
		if (parent === undefined) {
			this.checkbox(step, mark, text);
			return;
		}
		parent.subtasks.push({ step, text, status: taskStatusOf(mark, completed) });
	}

	line(raw: string): void {
		const trimmed = raw.trim();
		if (trimmed.length === 0) {
			this.#flushParagraph();
			return;
		}
		const sub = SUB_HEADING.exec(raw);
		if (sub) {
			this.#flushParagraph();
			const name = sub[1].toLowerCase();
			this.#subsection = name.startsWith("approach")
				? "approach"
				: name.startsWith("acceptance")
					? "acceptance"
					: name.startsWith("file")
						? "files"
						: "body";
			return;
		}
		const complexity = COMPLEXITY_LINE.exec(trimmed);
		if (complexity) {
			this.stage.complexity = complexity[1].toLowerCase() as "low" | "medium" | "high";
			return;
		}
		const depends = DEPENDS_LINE.exec(trimmed);
		if (depends) {
			this.stage.dependencies = depends[1]
				.split(",")
				.map((dependency) => dependency.trim())
				.filter((dependency) => dependency.length > 0);
			return;
		}
		if (this.#subsection === "files") {
			const file = FILE_LINE.exec(raw);
			if (file) {
				this.stage.files.push({ path: file[1], change: file[2] as "A" | "M" | "D" });
			}
			return;
		}
		const bullet = BULLET_LINE.exec(raw);
		if (bullet) {
			this.#flushParagraph();
			if (this.#subsection === "approach") this.stage.approach.push(bullet[1].trim());
			else this.#bodyBullets.push(bullet[1].trim());
			return;
		}
		if (this.#subsection === "body") this.#paragraph.push(trimmed);
	}

	diagram(source: string): void {
		this.#flushParagraph();
		this.stage.diagrams.push(source);
	}

	change(change: PlanChange): void {
		this.#flushParagraph();
		this.stage.changes.push(change);
	}
}

const isDocumentTitle = (
	match: RegExpExecArray | null,
	stage: StageBuilder | null,
	title: string | null,
): match is RegExpExecArray => match !== null && stage === null && title === null;

export function parsePlanMarkdown(content: string): ParsedPlanMarkdown {
	const allLines = content.split("\n");
	const frontmatter = parseFrontmatter(allLines);
	const lines = allLines.slice(frontmatter.bodyStart);
	const checkboxByLine = new Map(scanChecklist(lines.join("\n")).map((item) => [item.line, item]));
	const explicitStages = lines.some((line) => {
		const heading = STAGE_HEADING.exec(line);
		return heading !== null && STAGE_ID_COMMENT.test(heading[1]);
	});

	let title = frontmatter.title;
	const checklist: ChecklistItem[] = [];
	const sections: PlanSection[] = [];
	let section = new SectionBuilder();
	let sectionTitle: string | null = null;
	const finishSection = () => {
		section.flush();
		if (section.blocks.length > 0 || sectionTitle !== null) {
			sections.push({ title: sectionTitle, blocks: section.blocks });
		}
		section = new SectionBuilder();
		sectionTitle = null;
	};
	const stages: ParsedPlanStage[] = [];
	let stage: StageBuilder | null = null;
	let fence: { language: string; path: string | null; lines: string[] } | null = null;

	for (const [line, raw] of lines.entries()) {
		const fenceMatch = FENCE_LINE.exec(raw.trim());
		if (fence !== null) {
			if (fenceMatch !== null) {
				const code = fence.lines.join("\n");
				if (stage !== null) {
					if (fence.language === "mermaid") stage.diagram(code);
					else if (fence.path !== null) stage.change({ path: fence.path, patch: code });
					// Other stage code fences are dropped from the structure
					// (they stay in the markdown, which remains the source of truth).
				} else {
					section.code(fence.language, code, fence.path);
				}
				fence = null;
			} else {
				fence.lines.push(raw);
			}
			continue;
		}
		if (fenceMatch !== null) {
			fence = {
				language: fenceMatch[1] ?? "",
				path: FENCE_PATH.exec(fenceMatch[2] ?? "")?.[1] ?? null,
				lines: [],
			};
			continue;
		}

		const stageHeading = STAGE_HEADING.exec(raw);
		if (stageHeading !== null) {
			const tagged = STAGE_ID_COMMENT.test(stageHeading[1]);
			if (!explicitStages || tagged) {
				if (stage !== null) stages.push(stage.finish());
				else finishSection();
				stage = new StageBuilder(stageHeading[1]);
			} else {
				if (stage !== null) {
					stages.push(stage.finish());
					stage = null;
				} else finishSection();
				sectionTitle = stageHeading[1].trim();
			}
			continue;
		}

		const checkbox = checkboxByLine.get(line);
		if (checkbox !== undefined) {
			checklist.push({
				step: checkbox.step,
				text: checkbox.text,
				completed: checkbox.completed,
			});
			if (stage !== null) {
				if (checkbox.indent.length > 0) {
					stage.nestedCheckbox(checkbox.step, checkbox.mark, checkbox.text);
				} else {
					stage.checkbox(checkbox.step, checkbox.mark, checkbox.text);
				}
			}
			continue;
		}

		const titleHeading = /^#\s+(.+?)\s*$/.exec(raw);
		if (isDocumentTitle(titleHeading, stage, title)) {
			title = titleHeading[1];
			continue;
		}

		if (stage !== null) stage.line(raw);
		else section.line(raw);
	}
	if (stage !== null) stages.push(stage.finish());
	else finishSection();

	return {
		title,
		revision: frontmatter.revision,
		sections,
		stages,
		checklist,
	};
}
