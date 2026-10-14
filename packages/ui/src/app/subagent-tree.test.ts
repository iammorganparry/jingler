import { describe, expect, it } from "vitest"
import { buildSubagentTree } from "./subagent-tree.js"

const summary = (items: Parameters<typeof buildSubagentTree>[0]) =>
  buildSubagentTree(items).map(({ item, depth }) => `${depth}:${item.id}`)

describe("buildSubagentTree", () => {
  it("returns flat roots at depth 0 in input order", () => {
    expect(summary([{ id: "a" }, { id: "b", parentId: null }])).toEqual(["0:a", "0:b"])
  })

  it("nests children under their parent by depth, keeping sibling order", () => {
    expect(
      summary([
        { id: "orch" },
        { id: "c1", parentId: "orch" },
        { id: "g1", parentId: "c1" },
        { id: "c2", parentId: "orch" },
        { id: "other" }
      ])
    ).toEqual(["0:orch", "1:c1", "2:g1", "1:c2", "0:other"])
  })

  it("places a child listed before its parent under that parent", () => {
    expect(summary([{ id: "c", parentId: "p" }, { id: "p" }])).toEqual(["0:p", "1:c"])
  })

  it("treats a child whose parent is missing as a root", () => {
    expect(summary([{ id: "x", parentId: "gone" }])).toEqual(["0:x"])
  })

  it("emits each node once when parents form a cycle", () => {
    expect(summary([{ id: "a", parentId: "b" }, { id: "b", parentId: "a" }])).toEqual(["0:a", "1:b"])
  })
})
