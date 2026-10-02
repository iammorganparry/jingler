// @vitest-environment node
import { describe, expect, it } from "vitest"
import { fileDiffStat } from "./diff-presence.js"

describe("fileDiffStat", () => {
  it("counts changed lines without counting unified diff headers", () => {
    expect(fileDiffStat([
      "diff --git a/src/app.ts b/src/app.ts",
      "--- a/src/app.ts",
      "+++ b/src/app.ts",
      "@@ -1,2 +1,3 @@",
      "-old",
      "+new",
      "+added"
    ].join("\n"))).toEqual({ added: 2, removed: 1 })
  })
})
