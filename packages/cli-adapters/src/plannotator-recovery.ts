import { readFile, realpath } from "node:fs/promises"
import { isAbsolute, relative, resolve } from "node:path"

type JsonRecord = Readonly<Record<string, unknown>>

const isRecord = (value: unknown): value is JsonRecord =>
  typeof value === "object" && value !== null

export const plannotatorReviewPending = async (
  sessionFile: string | undefined,
  sessionsDir: string
): Promise<boolean> => {
  if (!sessionFile) return false

  let root: string
  let file: string
  try {
    ;[root, file] = await Promise.all([
      realpath(resolve(sessionsDir)),
      realpath(resolve(sessionFile))
    ])
  } catch {
    return false
  }

  const rel = relative(root, file)
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) return false

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
      const entry: unknown = JSON.parse(line)
      if (!isRecord(entry) || entry.type !== "custom" || entry.customType !== "plannotator") {
        continue
      }
      pending = isRecord(entry.data) &&
        entry.data.phase === "planning" &&
        entry.data.reviewPending === true
    } catch {
      return false
    }
  }
  return pending
}
