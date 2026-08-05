import { describe, expect, it } from "vitest"
import {
  canonicalPierrePath,
  createPierreCodeViewItem,
  createPierreCodeViewItemsFromPatch,
  createPierreFileContents,
  createPierreFileDiff,
  createPierreFileDiffFromPatch,
  createPierreGitStatusEntries,
  createPierrePartialFileDiff,
  jinglerStatusFromPierreDiff,
  pierreCacheKey,
  pierreItemVersion
} from "./pierre-model.js"

const singlePatch = [
  "diff --git a/src/value.ts b/src/value.ts",
  "index 1111111..2222222 100644",
  "--- a/src/value.ts",
  "+++ b/src/value.ts",
  "@@ -1,5 +1,5 @@",
  " one",
  "-two",
  "+TWO",
  " three",
  " four",
  " five",
  ""
].join("\n")

const addedPatch = [
  "diff --git a/docs/new.md b/docs/new.md",
  "new file mode 100644",
  "--- /dev/null",
  "+++ b/docs/new.md",
  "@@ -0,0 +1,2 @@",
  "+# New",
  "+Body",
  ""
].join("\n")

describe("Pierre file and patch models", () => {
  it("builds canonical clean files with content-derived cache keys", () => {
    const file = createPierreFileContents({
      path: "./src\\main.ts",
      contents: "export const value = 1\n",
      language: "typescript",
      revision: "blob-1"
    })
    const same = createPierreFileContents({
      path: "src/main.ts",
      contents: file.contents,
      language: "typescript",
      revision: "blob-1"
    })
    const changed = createPierreFileContents({
      path: "src/main.ts",
      contents: "export const value = 2\n",
      language: "typescript",
      revision: "blob-2"
    })

    expect(file).toMatchObject({ name: "src/main.ts", lang: "typescript" })
    expect(file.cacheKey).toBe(same.cacheKey)
    expect(changed.cacheKey).not.toBe(file.cacheKey)
    expect(() => canonicalPierrePath("../outside.ts")).toThrow(/repo-relative/)
  })

  it.each([
    {
      name: "modified",
      input: { status: "modified", path: "src/a.ts", before: "old\n", after: "new\n" },
      type: "change",
      status: "modified"
    },
    {
      name: "added",
      input: { status: "added", path: "src/new.ts", after: "new\n" },
      type: "new",
      status: "added"
    },
    {
      name: "untracked",
      input: { status: "untracked", path: "notes.txt", after: "new\n" },
      type: "new",
      status: "added"
    },
    {
      name: "deleted",
      input: { status: "deleted", path: "src/gone.ts", before: "old\n" },
      type: "deleted",
      status: "deleted"
    },
    {
      name: "renamed with changes",
      input: {
        status: "renamed",
        path: "src/new-name.ts",
        previousPath: "src/old-name.ts",
        before: "old\n",
        after: "new\n"
      },
      type: "rename-changed",
      status: "renamed"
    }
  ] as const)("represents $name files", ({ input, type, status }) => {
    const diff = createPierreFileDiff(input)
    expect(diff.type).toBe(type)
    expect(diff.name).toBe(input.path)
    expect(jinglerStatusFromPierreDiff(diff)).toBe(status)
    expect(diff.cacheKey).toMatch(/^jingler:diff:/)
  })

  it("keeps pure renames and empty files navigable without inventing hunks", () => {
    const rename = createPierreFileDiff({
      status: "renamed",
      path: "new.txt",
      previousPath: "old.txt",
      before: "same\n",
      after: "same\n"
    })
    const emptyAdded = createPierreFileDiff({
      status: "added",
      path: "empty.txt",
      after: ""
    })

    expect(rename).toMatchObject({
      name: "new.txt",
      prevName: "old.txt",
      type: "rename-pure",
      hunks: []
    })
    expect(emptyAdded).toMatchObject({
      name: "empty.txt",
      type: "new",
      hunks: [],
      additionLines: []
    })
    expect(() =>
      createPierreFileDiff({ status: "renamed", path: "new.txt", after: "same\n" })
    ).toThrow(/previousPath/)
  })

  it("parses single-file, partial-hunk, and multi-file patches", () => {
    const full = createPierreFileDiffFromPatch(singlePatch)
    const partial = createPierrePartialFileDiff(singlePatch, 0)
    const items = createPierreCodeViewItemsFromPatch(`${singlePatch}\n${addedPatch}`)

    expect(full).toMatchObject({ name: "src/value.ts", type: "change" })
    expect(full.hunks).toHaveLength(1)
    expect(partial.isPartial).toBe(true)
    expect(partial.unifiedLineCount).toBeLessThan(full.unifiedLineCount)
    expect(items.map((item) => item.id)).toEqual([
      "src/value.ts",
      "docs/new.md"
    ])
    expect(items.map((item) => item.type)).toEqual(["diff", "diff"])
    expect(() =>
      createPierreFileDiffFromPatch(`${singlePatch}\n${addedPatch}`)
    ).toThrow(/single-file/)
  })

  it("keeps CodeView versions, cache keys, and Git statuses stable", () => {
    const file = createPierreFileContents({ path: "src/a.ts", contents: "a\n" })
    const item = createPierreCodeViewItem({ type: "file", file })

    expect(item.version).toBe(
      createPierreCodeViewItem({ type: "file", file }).version
    )
    expect(pierreCacheKey("file", "a", 1)).toBe(
      pierreCacheKey("file", "a", 1)
    )
    expect(pierreCacheKey("file", "a", 2)).not.toBe(
      pierreCacheKey("file", "a", 1)
    )
    expect(pierreItemVersion("a", 1)).toBe(pierreItemVersion("a", 1))
    expect(createPierreGitStatusEntries([
      { path: "clean.ts", status: "clean" },
      { path: "src\\changed.ts", status: "modified" },
      { path: "new.ts", status: "untracked" },
      { path: "gone.ts", status: "deleted" },
      { path: "moved.ts", status: "renamed" }
    ])).toEqual([
      { path: "src/changed.ts", status: "modified" },
      { path: "new.ts", status: "untracked" },
      { path: "gone.ts", status: "deleted" },
      { path: "moved.ts", status: "renamed" }
    ])
  })
})
