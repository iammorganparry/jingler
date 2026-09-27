import { readFile, rename, stat, unlink, writeFile } from "node:fs/promises"
import { randomUUID } from "node:crypto"
import type { ChecklistStatus } from "./generated/checklist.ts"
import { updateChecklistStatuses } from "./generated/checklist.ts"

const pendingWrites = new Map<string, Promise<unknown>>()

const persistOnce = async (
  planFilePath: string,
  updates: ReadonlyMap<number, ChecklistStatus>
): Promise<string> => {
  const [current, metadata] = await Promise.all([
    readFile(planFilePath, "utf8"),
    stat(planFilePath)
  ])
  const next = updateChecklistStatuses(current, updates)
  if (next === current) return current

  const temporaryPath = `${planFilePath}.${randomUUID()}.tmp`
  try {
    await writeFile(temporaryPath, next, { encoding: "utf8", mode: metadata.mode })
    if (await readFile(planFilePath, "utf8") !== current) {
      throw new Error(`Plan changed while its status was being updated: ${planFilePath}`)
    }
    await rename(temporaryPath, planFilePath)
  } catch (error) {
    await unlink(temporaryPath).catch(() => {})
    throw error
  }
  return next
}

/** Serialize marker updates and abort when an external edit is observed before replacement. */
export async function persistPlanStatuses(
  planFilePath: string,
  updates: ReadonlyMap<number, ChecklistStatus>
): Promise<string> {
  const previous = pendingWrites.get(planFilePath) ?? Promise.resolve()
  const operation = previous.catch(() => {}).then(() => persistOnce(planFilePath, updates))
  pendingWrites.set(planFilePath, operation)
  try {
    return await operation
  } finally {
    if (pendingWrites.get(planFilePath) === operation) pendingWrites.delete(planFilePath)
  }
}

/**
 * Remembers the text each plan file had when it was last sent for review.
 * `begin` returns the previous reviewed text only when the resubmission changed it.
 */
export const createReviewedContent = () => {
  const reviewed = new Map<string, string>()
  return {
    begin(path: string, content: string): string | null {
      const prior = reviewed.get(path)
      reviewed.set(path, content)
      return prior !== undefined && prior !== content ? prior : null
    }
  }
}
