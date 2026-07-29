import { describe, expect, it } from "vitest"
import { codexFileChangeStats } from "./codex-file-change.js"

const updateDiff = [
  "diff --git a/src/a.ts b/src/a.ts",
  "index 1111111..2222222 100644",
  "--- a/src/a.ts",
  "+++ b/src/a.ts",
  "@@ -1,3 +1,3 @@",
  " const before = true",
  "-const value = 'old'",
  "+const value = 'new'",
  " export { value }"
].join("\n")

const createDiff = [
  "diff --git a/src/new.ts b/src/new.ts",
  "new file mode 100644",
  "--- /dev/null",
  "+++ b/src/new.ts",
  "@@ -0,0 +1,2 @@",
  "+export const answer = 42",
  "+export const ready = true"
].join("\n")

describe("codexFileChangeStats", () => {
  it("extracts hunk lines and excludes unified-diff metadata from totals", () => {
    expect(codexFileChangeStats([{ path: "src/a.ts", kind: "update", diff: updateDiff }])).toStrictEqual({
      diff: { added: 1, removed: 1 },
      preview: [
        " const before = true",
        "-const value = 'old'",
        "+const value = 'new'",
        " export { value }"
      ].join("\n")
    })
  })

  it("summarizes a created file as additions only", () => {
    expect(codexFileChangeStats([{ path: "src/new.ts", kind: "add", diff: createDiff }])).toStrictEqual({
      diff: { added: 2, removed: 0 },
      preview: "+export const answer = 42\n+export const ready = true"
    })
  })

  it("combines multiple files and preserves the legacy no-diff fallback", () => {
    const combined = codexFileChangeStats([
      { path: "src/a.ts", kind: "update", diff: updateDiff },
      { path: "src/new.ts", kind: "add", diff: createDiff }
    ])
    expect(combined.diff).toStrictEqual({ added: 3, removed: 1 })
    expect(combined.preview).toContain("-const value = 'old'")
    expect(combined.preview).toContain("+export const answer = 42")
    expect(codexFileChangeStats([{ path: "src/old.ts", kind: "update" }])).toStrictEqual({
      diff: null,
      preview: null
    })
    expect(codexFileChangeStats([null, "invalid", { diff: 42 }])).toStrictEqual({
      diff: null,
      preview: null
    })
  })
})
