/**
 * The prompt handed to the session's agent to resolve a PR's merge conflicts.
 * Pure so the UI (building the prompt before calling `onResolveConflicts`) and
 * any future caller can test it without a running session.
 */
export const conflictResolutionPrompt = (files: ReadonlyArray<string>): string =>
  `Resolve the merge conflicts in ${files.length === 1 ? "this file" : "these files"}:\n\n` +
  `${files.map((path) => `- ${path}`).join("\n")}\n\n` +
  `Keep the intent of both sides where possible, then verify the result builds.`
