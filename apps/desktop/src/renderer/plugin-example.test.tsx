// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { LoadedPlugin } from "@jingler/core"
import type { Session } from "@jingler/core"
import { PluginTabHost } from "./plugin-tab-host.js"
import { loadPluginUi } from "./plugin-loader.js"
import manifestJson from "../../../../plugins/examples/hello-tab/jingler.plugin.json"

/**
 * The shipped example plugin, run through the real loader.
 *
 * Every other test in this area substitutes something: a fake importer, a fake
 * manifest, a fake view. This one uses `plugins/examples/hello-tab` exactly as
 * it is published — its generated `jingler.plugin.json` and its actual UI
 * module — so if the example ever stops being a valid plugin, or the loader
 * stops accepting one, this fails.
 *
 * It matters more than it looks. The example is what an author copies and what
 * an agent is pointed at; an example that no longer loads teaches the wrong
 * thing to everyone who starts from it.
 */

vi.mock("./rpc-client.js", () => ({
  rpc: {
    pluginsInvoke: vi.fn(async () => null),
    pluginsStorageGet: vi.fn(async () => 2),
    pluginsStorageSet: vi.fn(async () => undefined),
    pluginsStorageDelete: vi.fn(async () => undefined),
    pluginsStorageKeys: vi.fn(async () => [])
  }
}))

afterEach(cleanup)

const session = (over: Partial<Session> = {}): Session =>
  ({
    id: "s1",
    repo: "trigify/api",
    branch: "jingler/s1",
    title: "Fix auth",
    status: "idle",
    cli: "claude",
    diff: { added: 0, removed: 0 },
    prNumber: 42,
    costUsd: 0,
    tokens: 0,
    updatedAt: "2026-07-16T00:00:00.000Z",
    chats: [],
    activeChatId: "c1",
    worktreePath: "/tmp/s1",
    baseBranch: "main",
    mode: "auto",
    ...over
  }) as Session

const asLoadedPlugin = (): LoadedPlugin =>
  ({
    manifest: manifestJson,
    dir: "/home/dev/jingler/plugins/hello-tab",
    enabled: true,
    activated: false,
    builtin: false
  }) as unknown as LoadedPlugin

/** The real module, transpiled by vitest — not a stand-in. */
const importExample = async () =>
  await import("../../../../plugins/examples/hello-tab/src/ui.js")

describe("the shipped hello-tab example", () => {
  it("has a committed manifest matching the TypeScript it is generated from", async () => {
    // `jingler.plugin.json` is written by the build from `src/manifest.ts`. If
    // someone edits the TypeScript and forgets to rebuild, Jingler reads the
    // stale JSON — so the tab it loads is not the tab the code declares, and
    // `definePlugin`'s compile-time guarantee silently stops describing reality.
    const { manifest } = await import(
      "../../../../plugins/examples/hello-tab/src/manifest.js"
    )
    const { $schema: _schema, ...committed } = manifestJson as Record<string, unknown>
    expect(committed).toEqual(manifest)
  })

  it("loads through the real loader and contributes its declared tab", async () => {
    const result = await loadPluginUi(asLoadedPlugin(), importExample)

    expect(result.ok, result.ok ? "" : result.error.message).toBe(true)
    if (!result.ok) return

    expect(result.plugin.id).toBe("hello-tab")
    expect(result.plugin.tabs).toHaveLength(1)
    expect(result.plugin.tabs[0]?.id).toBe("hello-tab.greeting")
    expect(result.plugin.tabs[0]?.label).toBe("Hello")
  })

  it("resolves the lucide icon its manifest names", async () => {
    // `Sparkles` is a real icon; if resolution regressed to the fallback box,
    // every plugin tab in the app would look identical.
    const Icons = await import("lucide-react")
    const result = await loadPluginUi(asLoadedPlugin(), importExample)
    if (!result.ok) throw new Error(result.error.message)
    expect(result.plugin.tabs[0]?.icon).toBe(Icons.Sparkles)
  })

  it("renders real content, with the session it was given", async () => {
    const result = await loadPluginUi(asLoadedPlugin(), importExample)
    if (!result.ok) throw new Error(result.error.message)
    const tab = result.plugin.tabs[0]!

    render(
      <PluginTabHost pluginId="hello-tab" reloadKey="hello-tab@1.0.0" session={session()}>
        {tab.render(session(), {
          activeTabId: "hello-tab.greeting",
          splitOpen: false,
          onConnectGithub: () => {},
          onSelectTab: () => {}
        })}
      </PluginTabHost>
    )

    expect(screen.getByTestId("hello-tab-body")).toBeTruthy()
    expect(screen.getByText("Hello from a plugin")).toBeTruthy()
    // Session data reached the plugin through the snapshot.
    expect(screen.getByText("trigify/api")).toBeTruthy()
    expect(screen.getByText("#42")).toBeTruthy()
  })

  it("persists through its own storage, proving the bridge is live", async () => {
    const result = await loadPluginUi(asLoadedPlugin(), importExample)
    if (!result.ok) throw new Error(result.error.message)
    const tab = result.plugin.tabs[0]!

    render(
      <PluginTabHost pluginId="hello-tab" reloadKey="hello-tab@1.0.0" session={session()}>
        {tab.render(session(), {
          activeTabId: "hello-tab.greeting",
          splitOpen: false,
          onConnectGithub: () => {},
          onSelectTab: () => {}
        })}
      </PluginTabHost>
    )

    // The mock returns 2 for the stored count; the plugin increments it.
    await waitFor(() =>
      expect(screen.getByTestId("hello-tab-visits").textContent).toBe("3")
    )
  })

  it("is visible on every session, as its manifest declares", async () => {
    const result = await loadPluginUi(asLoadedPlugin(), importExample)
    if (!result.ok) throw new Error(result.error.message)
    const tab = result.plugin.tabs[0]!

    for (const s of [session(), session({ prNumber: null, worktreePath: undefined })]) {
      expect(tab.when({ session: s, hasPlan: false })).toBe(true)
    }
  })
})
