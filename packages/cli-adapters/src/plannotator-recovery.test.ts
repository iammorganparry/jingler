import { mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { plannotatorReviewPending } from "./plannotator-recovery.js"

describe("plannotatorReviewPending", () => {
  it("reads only the latest persisted Plannotator state inside the sessions directory", async () => {
    const root = await mkdtemp(join(tmpdir(), "jingler-plannotator-recovery-"))
    const file = join(root, "session.jsonl")
    await writeFile(file, [
      JSON.stringify({ type: "custom", customType: "plannotator", data: { phase: "planning", reviewPending: true } }),
      JSON.stringify({ type: "custom", customType: "plannotator", data: { phase: "planning", reviewPending: false } })
    ].join("\n"))
    expect(await plannotatorReviewPending(file, root)).toBe(false)
    await writeFile(file, JSON.stringify({ type: "custom", customType: "plannotator", data: { phase: "planning", reviewPending: true } }))
    expect(await plannotatorReviewPending(file, root)).toBe(true)
    expect(await plannotatorReviewPending(join(root, "..", "outside.jsonl"), root)).toBe(false)
  })
})
