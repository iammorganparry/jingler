import { describe, expect, it } from "vitest"
import * as Icons from "lucide-react"
import type { LoadedPlugin } from "@starbase/core"
import { loadPluginUi, loadPlugins, pluginModuleUrl, resolveIcon } from "./plugin-loader.js"

/**
 * The loader's job is not loading — it is refusing, precisely.
 *
 * A plugin is third-party code imported into the renderer's own realm, so every
 * assertion below is about a specific way a plugin can be wrong and the specific
 * thing the operator should be told about it.
 */

const plugin = (over: Partial<LoadedPlugin["manifest"]> = {}): LoadedPlugin => ({
  manifest: {
    id: "hello",
    name: "Hello",
    version: "1.0.0",
    ui: "dist/ui.js",
    contributes: { tabs: [{ id: "hello.greeting", label: "Hello" }] },
    ...over
  } as LoadedPlugin["manifest"],
  dir: "/home/dev/starbase/plugins/hello",
  enabled: true,
  activated: false,
  builtin: false
})

const View = () => null

describe("pluginModuleUrl", () => {
  it("addresses the plugin's own host on the custom scheme", () => {
    expect(pluginModuleUrl(plugin())).toContain("starbase-plugin://hello/dist/ui.js")
  })

  it("carries the version, which is what makes hot reload possible at all", () => {
    // ES module imports are cached by URL for the life of the realm. Without a
    // changing key an author edits a file, reloads, and sees the ORIGINAL
    // module — indistinguishable from a broken watcher.
    expect(pluginModuleUrl(plugin({ version: "1.0.0" }))).toContain("?v=1.0.0")
    expect(pluginModuleUrl(plugin({ version: "1.0.1" }))).not.toContain("?v=1.0.0")
  })

  it("tolerates a leading ./ in the manifest's ui path", () => {
    expect(pluginModuleUrl(plugin({ ui: "./dist/ui.js" }))).toContain("hello/dist/ui.js")
  })
})

describe("resolveIcon", () => {
  it("resolves a real lucide name to that icon, not to the fallback", () => {
    // Asserted by IDENTITY. A `typeof === "function"` check here would pass
    // while the implementation silently fell back for every icon, because
    // lucide's icons are `forwardRef` objects rather than plain functions —
    // which is exactly the bug this assertion caught.
    expect(resolveIcon("GitPullRequest")).toBe(Icons.GitPullRequest)
    expect(resolveIcon("MessagesSquare")).toBe(Icons.MessagesSquare)
  })

  it("falls back rather than failing on a typo", () => {
    // A mistyped icon is cosmetic. Refusing to load would make a one-character
    // mistake look like a crash.
    expect(resolveIcon("GitPullRequests")).toBe(Icons.Boxes)
    expect(resolveIcon(undefined)).toBe(Icons.Boxes)
  })

  it("falls back for a lucide export that is not a component", () => {
    // The barrel also exports icon-node data maps; rendering one would throw.
    expect(resolveIcon("gitPullRequestNode")).toBe(Icons.Boxes)
  })
})

describe("loadPluginUi", () => {
  it("builds a tab contribution from a well-formed module", async () => {
    const result = await loadPluginUi(plugin(), async () => ({
      default: { views: { "hello.greeting": View } }
    }))

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.plugin.tabs).toHaveLength(1)
    expect(result.plugin.tabs[0]?.id).toBe("hello.greeting")
    expect(result.plugin.tabs[0]?.label).toBe("Hello")
  })

  it("defaults a plugin tab to sorting after the built-ins", async () => {
    const result = await loadPluginUi(plugin(), async () => ({
      default: { views: { "hello.greeting": View } }
    }))
    if (!result.ok) throw new Error("expected ok")
    expect(result.plugin.tabs[0]?.order).toBe(100)
  })

  it("reports a module that will not import, naming the file", async () => {
    const result = await loadPluginUi(plugin(), async () => {
      throw new SyntaxError("Unexpected token '<'")
    })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.message).toContain("dist/ui.js")
    expect(result.error.message).toContain("Unexpected token")
  })

  it("reports a module with no default export, and says what was expected", async () => {
    const result = await loadPluginUi(plugin(), async () => ({ views: {} }))
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.message).toContain("no default export")
    expect(result.error.message).toContain("definePlugin")
  })

  it("refuses a plugin that declares a tab but ships no view for it", async () => {
    // Checked against the MANIFEST at load time, so the operator learns at
    // install rather than when they eventually click an empty tab.
    const result = await loadPluginUi(plugin(), async () => ({
      default: { views: { "hello.somethingElse": View } }
    }))
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.message).toContain("hello.greeting")
    expect(result.error.message).toContain("no matching view")
  })

  it("accepts a plugin with no UI entry — a host-only plugin is legal", async () => {
    const result = await loadPluginUi(
      plugin({ ui: undefined, contributes: undefined }),
      async () => {
        throw new Error("should not be imported")
      }
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.plugin.tabs).toEqual([])
  })

  it("never imports a module for a plugin that contributes no tabs", async () => {
    let imported = false
    await loadPluginUi(plugin({ contributes: { tabs: [] } }), async () => {
      imported = true
      return {}
    })
    expect(imported).toBe(false)
  })

  describe("manifest visibility maps to a predicate", () => {
    const withWhen = async (when: string) => {
      const result = await loadPluginUi(
        plugin({
          contributes: { tabs: [{ id: "hello.greeting", label: "Hello", when }] }
        } as Partial<LoadedPlugin["manifest"]>),
        async () => ({ default: { views: { "hello.greeting": View } } })
      )
      if (!result.ok) throw new Error(result.error.message)
      return result.plugin.tabs[0]!.when
    }

    const session = (over: Record<string, unknown> = {}) =>
      ({ session: { prNumber: null, worktreePath: null, issueNumber: null, ...over }, hasPlan: false }) as never

    it("hasPr", async () => {
      const when = await withWhen("hasPr")
      expect(when(session({ prNumber: 3 }))).toBe(true)
      expect(when(session())).toBe(false)
    })

    it("hasWorktree", async () => {
      const when = await withWhen("hasWorktree")
      expect(when(session({ worktreePath: "/tmp/wt" }))).toBe(true)
      expect(when(session())).toBe(false)
    })

    it("hasIssue", async () => {
      const when = await withWhen("hasIssue")
      expect(when(session({ issueNumber: 9 }))).toBe(true)
      expect(when(session())).toBe(false)
    })

    it("defaults to always", async () => {
      const when = await withWhen("always")
      expect(when(session())).toBe(true)
    })
  })
})

describe("loadPlugins", () => {
  it("keeps the good plugins when one fails, rather than aborting the batch", async () => {
    const good = plugin()
    const bad = { ...plugin(), manifest: { ...plugin().manifest, id: "broken" } }

    const { active, errors } = await loadPlugins([good, bad], async (url) => {
      if (url.includes("broken")) throw new Error("boom")
      return { default: { views: { "hello.greeting": View } } }
    })

    expect(active.map((p) => p.id)).toEqual(["hello"])
    expect(errors.map((e) => e.id)).toEqual(["broken"])
  })

  it("skips disabled plugins entirely — a disabled plugin runs no code", async () => {
    let imported = false
    const { active } = await loadPlugins([{ ...plugin(), enabled: false }], async () => {
      imported = true
      return {}
    })
    expect(imported).toBe(false)
    expect(active).toEqual([])
  })

  it("loads independently, so one slow plugin does not gate the others", async () => {
    const slow = { ...plugin(), manifest: { ...plugin().manifest, id: "slow" } }
    const order: string[] = []

    await loadPlugins([slow, plugin()], async (url) => {
      if (url.includes("slow")) await new Promise((r) => setTimeout(r, 30))
      order.push(url.includes("slow") ? "slow" : "fast")
      return { default: { views: { "hello.greeting": View } } }
    })

    // Concurrent, not sequential: the fast one finishes first despite being
    // second in the list.
    expect(order).toEqual(["fast", "slow"])
  })
})
