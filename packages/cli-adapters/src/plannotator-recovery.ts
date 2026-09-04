import { readFile, realpath } from "node:fs/promises"
import { isAbsolute, relative, resolve } from "node:path"
import { Option, Schema } from "effect"

const PlannotatorEntry = Schema.Struct({
  type: Schema.Literal("custom"),
  customType: Schema.Literal("plannotator"),
  data: Schema.Unknown
})
const PlannotatorState = Schema.Struct({
  phase: Schema.Literal("planning"),
  reviewPending: Schema.Literal(true)
})
const decodePlannotatorEntry = Schema.decodeUnknownOption(PlannotatorEntry)
const isPendingReview = Schema.is(PlannotatorState)

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
      const entry = decodePlannotatorEntry(JSON.parse(line))
      if (Option.isNone(entry)) continue
      pending = isPendingReview(entry.value.data)
    } catch {
      return false
    }
  }
  return pending
}
