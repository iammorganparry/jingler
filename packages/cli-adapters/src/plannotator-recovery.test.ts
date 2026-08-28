import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { plannotatorReviewPending } from "./plannotator-recovery.js"

const state = (reviewPending: boolean): string => JSON.stringify({
  type: "custom",
  customType: "plannotator",
  data: { phase: "planning", reviewPending }
})

describe("plannotatorReviewPending", () => {
  it("uses only the latest persisted Plannotator state", async () => {
    const root = await mkdtemp(join(tmpdir(), "jingler-plannotator-recovery-"))
    try {
      const file = join(root, "session.jsonl")
      await writeFile(file, [state(true), state(false)].join("\n"))
      expect(await plannotatorReviewPending(file, root)).toBe(false)

      await writeFile(file, [state(false), state(true)].join("\n"))
      expect(await plannotatorReviewPending(file, root)).toBe(true)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it("fails closed for absent and malformed retained sessions", async () => {
    const root = await mkdtemp(join(tmpdir(), "jingler-plannotator-recovery-"))
    try {
      expect(await plannotatorReviewPending(undefined, root)).toBe(false)
      expect(await plannotatorReviewPending(join(root, "missing.jsonl"), root)).toBe(false)

      const malformed = join(root, "malformed.jsonl")
      await writeFile(malformed, `${state(true)}\n{"type":`)
      expect(await plannotatorReviewPending(malformed, root)).toBe(false)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it("rejects lexical and symlink escapes from the sessions directory", async () => {
    const root = await mkdtemp(join(tmpdir(), "jingler-plannotator-recovery-"))
    const outside = await mkdtemp(join(tmpdir(), "jingler-plannotator-outside-"))
    try {
      const outsideFile = join(outside, "session.jsonl")
      await writeFile(outsideFile, state(true))
      expect(await plannotatorReviewPending(outsideFile, root)).toBe(false)
      expect(await plannotatorReviewPending(join(root, "..", "outside.jsonl"), root)).toBe(false)

      const linkedFile = join(root, "linked.jsonl")
      await symlink(outsideFile, linkedFile)
      expect(await plannotatorReviewPending(linkedFile, root)).toBe(false)
    } finally {
      await Promise.all([
        rm(root, { recursive: true, force: true }),
        rm(outside, { recursive: true, force: true })
      ])
    }
  })
})
