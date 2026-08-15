import { describe, expect, it } from "vitest"
import { isIgnoredPluginWatchPath } from "./plugins.js"

describe("isIgnoredPluginWatchPath", () => {
  it("drops node_modules and .git subtrees (the dev-watch noise)", () => {
    expect(isIgnoredPluginWatchPath("/repo/plugins/node_modules/foo/index.js")).toBe(true)
    expect(isIgnoredPluginWatchPath("/repo/plugins/github-issues/node_modules/x.js")).toBe(true)
    expect(isIgnoredPluginWatchPath("/repo/plugins/.git/HEAD")).toBe(true)
    expect(isIgnoredPluginWatchPath("node_modules/foo.js")).toBe(true)
    expect(isIgnoredPluginWatchPath("plugins\\github-issues\\node_modules\\x.js")).toBe(true)
  })

  it("keeps the files live reload actually targets", () => {
    expect(isIgnoredPluginWatchPath("/home/u/jingler/plugins/my-plugin/jingler.plugin.json")).toBe(false)
    expect(isIgnoredPluginWatchPath("/home/u/jingler/plugins/my-plugin/dist/ui.js")).toBe(false)
    expect(isIgnoredPluginWatchPath("/repo/plugins/github-issues/dist/ui.js")).toBe(false)
    expect(isIgnoredPluginWatchPath("/repo/plugins/github-issues")).toBe(false)
  })

  it("does not over-match name fragments", () => {
    expect(isIgnoredPluginWatchPath("/repo/plugins/my_node_modules_viewer/dist/ui.js")).toBe(false)
    expect(isIgnoredPluginWatchPath("/repo/plugins/gitty/dist/ui.js")).toBe(false)
  })
})
