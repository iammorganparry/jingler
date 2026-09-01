// @generated — DO NOT EDIT. Source: packages/shared/checklist.ts
/**
 * Checklist parsing and progress tracking utilities.
 *
 * Shared between Pi extension and OpenCode plugin for plan execution tracking.
 */

export interface ChecklistItem {
  /** 1-based step number, compatible with markCompletedSteps/extractDoneSteps. */
  step: number;
  text: string;
  completed: boolean;
}

export type ChecklistStatus = "pending" | "in-progress" | "blocked" | "completed";

export interface ScannedChecklistItem extends ChecklistItem {
  line: number;
  indent: string;
  mark: string;
  prefix: string;
  suffix: string;
}

/**
 * Parse standard markdown checkboxes from file content.
 *
 * Matches lines like:
 *   - [ ] Step description
 *   - [x] Completed step
 *   * [ ] Alternative bullet
 */
// Jingler fork: the shared checkbox grammar, reused by the structured plan
// parser (plan-parse.ts) so flat [DONE:n] numbering and the rich stage/task
// model can never disagree. Extends upstream with `~` (in-progress) and `-`
// (blocked) marks and with indented (nested) checkboxes.
export const CHECKLIST_PATTERN = /[-*]\s*\[([ xX~-])\]\s+(.+)/;

export function scanChecklist(content: string): ScannedChecklistItem[] {
  const items: ScannedChecklistItem[] = [];
  const lines = content.split("\n");
  let fenced = false;
  for (const [line, raw] of lines.entries()) {
    if (/^```[\w-]*\s*$/.test(raw.trim())) {
      fenced = !fenced;
      continue;
    }
    if (fenced) continue;
    const match = /^(\s*)([-*]\s*\[)([ xX~-])(\]\s+)(.*)$/.exec(raw);
    if (!match) continue;
    const text = match[5].trim();
    if (text.length === 0) continue;
    items.push({
      step: items.length + 1,
      text,
      completed: /[xX]/.test(match[3]),
      line,
      indent: match[1],
      mark: match[3],
      prefix: `${match[1]}${match[2]}`,
      suffix: `${match[4]}${match[5]}`,
    });
  }
  return items;
}

export function parseChecklist(content: string): ChecklistItem[] {
  return scanChecklist(content).map(({ step, text, completed }) => ({ step, text, completed }));
}

export function extractDoneSteps(message: string): number[] {
  const steps: number[] = [];
  for (const match of message.matchAll(/\[DONE:(\d+)\]/gi)) {
    const step = Number(match[1]);
    if (Number.isFinite(step)) steps.push(step);
  }
  return steps;
}

export function markCompletedSteps(text: string, items: ChecklistItem[]): number {
  const doneSteps = extractDoneSteps(text);
  for (const step of doneSteps) {
    const item = items.find((t) => t.step === step);
    if (item) item.completed = true;
  }
  return doneSteps.length;
}

const markerForStatus: Readonly<Record<ChecklistStatus, string>> = {
  pending: " ",
  "in-progress": "~",
  blocked: "-",
  completed: "x",
};

/** Rewrite checkbox markers by their stable document-order step number. */
export function updateChecklistStatuses(
  content: string,
  updates: ReadonlyMap<number, ChecklistStatus>,
): string {
  if (updates.size === 0) return content;
  const lines = content.split("\n");
  for (const item of scanChecklist(content)) {
    const status = updates.get(item.step);
    if (status !== undefined) {
      lines[item.line] = `${item.prefix}${markerForStatus[status]}${item.suffix}`;
    }
  }
  return lines.join("\n");
}
