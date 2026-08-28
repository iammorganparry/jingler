import { readFile } from "node:fs/promises"
import { relative, resolve } from "node:path"

type JsonRecord = Readonly<Record<string, unknown>>

const record = (value: unknown): JsonRecord | null =>
  typeof value === "object" && value !== null ? value as JsonRecord : null

export const plannotatorReviewPending = async (
  sessionFile: string | undefined,
  sessionsDir: string
): Promise<boolean> => {
  if (!sessionFile) return false
  const root = resolve(sessionsDir)
  const file = resolve(sessionFile)
  const rel = relative(root, file)
  if (rel.startsWith("..") || rel === "" || file === root) return false

  let source: string
  try {
    source = await readFile(file, "utf8")
  } catch {
    return false
  }

  let pending = false
  for (const line of source.split("\n")) {
    if (!line.trim()) continue
    try {
      const entry = record(JSON.parse(line))
      if (entry?.type !== "custom" || entry.customType !== "plannotator") continue
      const data = record(entry.data)
      pending = data?.phase === "planning" && data.reviewPending === true
    } catch {
      return false
    }
  }
  return pending
}
