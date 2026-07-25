import { describe, expect, it } from "vitest"
import { diffCounts } from "./diff-presence.js"

const patch = [
  "diff --git a/src/a.ts b/src/a.ts",
  "--- a/src/a.ts",
  "+++ b/src/a.ts",
  "@@ -1,3 +1,4 @@",
  " unchanged",
  "-gone",
  "+added",
  "+also added"
].join("\n")

describe("diffCounts", () => {
  it("counts changed lines and ignores the file headers", () => {
    // `---`/`+++` are the header pair, not a removal and an addition. Counting
    // them puts a permanent +1/−1 on every single-file diff.
    expect(diffCounts(patch)).toEqual({ added: 2, removed: 1 })
  })

  it("counts the final line when the patch has no trailing newline", () => {
    // Scanning in place has to terminate on the last line rather than after it;
    // dropping the tail would silently under-count the most recent edit.
    expect(diffCounts("+one\n+two")).toEqual({ added: 2, removed: 0 })
    expect(diffCounts("+one\n+two\n")).toEqual({ added: 2, removed: 0 })
  })

  it("handles an empty patch and blank lines", () => {
    expect(diffCounts("")).toEqual({ added: 0, removed: 0 })
    expect(diffCounts("\n\n")).toEqual({ added: 0, removed: 0 })
  })

  it("counts a bare +/- line, which is a real one-character change", () => {
    expect(diffCounts("+")).toEqual({ added: 1, removed: 0 })
    expect(diffCounts("-")).toEqual({ added: 0, removed: 1 })
  })

  it("does not count `+++`/`---` even when they appear mid-hunk", () => {
    expect(diffCounts("+++ b/x\n--- a/x\n+real")).toEqual({ added: 1, removed: 0 })
  })

  it("returns the same answer for a repeat call, memoized or not", () => {
    // The memo keys on the patch string, so a caller passing the same content
    // twice — the common case — must not observe a different result.
    const first = diffCounts(patch)
    expect(diffCounts(patch)).toEqual(first)
    expect(diffCounts(`${patch}\n+one more`)).toEqual({ added: 3, removed: 1 })
    expect(diffCounts(patch)).toEqual(first)
  })
})
