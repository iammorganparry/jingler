import { readFile, rename, unlink, writeFile } from "node:fs/promises"
import { randomUUID } from "node:crypto"
import type { ChecklistStatus } from "./generated/checklist.ts"
import { updateChecklistStatuses } from "./generated/checklist.ts"

/** Persist status markers in the Markdown scratchpad with one atomic replacement. */
export async function persistPlanStatuses(
  planFilePath: string,
  updates: ReadonlyMap<number, ChecklistStatus>
): Promise<string> {
  const current = await readFile(planFilePath, "utf8")
  const next = updateChecklistStatuses(current, updates)
  if (next === current) return current

  const temporaryPath = `${planFilePath}.${randomUUID()}.tmp`
  try {
    await writeFile(temporaryPath, next, "utf8")
    await rename(temporaryPath, planFilePath)
  } catch (error) {
    await unlink(temporaryPath).catch(() => {})
    throw error
  }
  return next
}
