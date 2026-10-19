import { describe, expect, it } from "vitest"
import { moveHeaderView, toggleHeaderView } from "./header-views.js"

describe("toggleHeaderView", () => {
  it("pins an unpinned view", () => {
    expect(toggleHeaderView(["changes"], "checks")).toEqual(["changes", "checks"])
  })

  it("unpins a pinned view", () => {
    expect(toggleHeaderView(["changes", "checks"], "changes")).toEqual(["checks"])
  })

  it("refuses to pin a sixth view", () => {
    const five = ["changes", "checks", "terminal", "browser", "files"]
    expect(toggleHeaderView(five, "plan")).toEqual(five)
  })
})

describe("moveHeaderView", () => {
  it("moves a view up one slot", () => {
    expect(moveHeaderView(["changes", "checks", "terminal"], "checks", "up")).toEqual([
      "checks",
      "changes",
      "terminal"
    ])
  })

  it("moves a view down one slot", () => {
    expect(moveHeaderView(["changes", "checks", "terminal"], "checks", "down")).toEqual([
      "changes",
      "terminal",
      "checks"
    ])
  })

  it("is a no-op at the top or bottom", () => {
    const views = ["changes", "checks", "terminal"]
    expect(moveHeaderView(views, "changes", "up")).toEqual(views)
    expect(moveHeaderView(views, "terminal", "down")).toEqual(views)
  })

  it("is a no-op for an unpinned id", () => {
    const views = ["changes", "checks"]
    expect(moveHeaderView(views, "plan", "up")).toEqual(views)
  })
})
