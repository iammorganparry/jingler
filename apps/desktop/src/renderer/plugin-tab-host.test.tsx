// @vitest-environment jsdom
/**
 * When a plugin's failure card clears, and — the point of this file — when it
 * must NOT.
 *
 * The boundary used to clear its error whenever `children` changed identity.
 * That reads as "the subtree is new" and means "anything re-rendered", because
 * the registry rebuilds the element on every pass. The session pane re-renders
 * constantly (live activity, status ticks), so a plugin that threw
 * deterministically was cleared, re-mounted, and threw again on every tick:
 * a card flickering under the operator and a console filling with one stack.
 *
 * The behaviour is invisible to a test that renders once, which is how it
 * shipped. Every case here re-renders at least twice.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { cleanup, render, screen } from "@testing-library/react"
import type { Session } from "@starbase/core"
import { PluginTabHost } from "./plugin-tab-host.js"

// The host builds a real `pluginBridge`, which reaches `rpc-client`, which
// reaches a `window.starbase` preload bridge that does not exist under jsdom.
// Left unmocked it does not fail the tests — it just leaks an unhandled
// rejection into the run, which is the kind of noise that trains people to
// ignore unhandled rejections.
vi.mock("./rpc-client.js", () => ({
  rpc: {
    pluginsInvoke: vi.fn(async () => undefined),
    pluginsStorageGet: vi.fn(async () => undefined),
    pluginsStorageSet: vi.fn(async () => undefined),
    pluginsStorageDelete: vi.fn(async () => undefined),
    pluginsStorageKeys: vi.fn(async () => [])
  }
}))

const session = (over: Partial<Session> = {}) =>
  ({
    id: "s1",
    repo: "trigify/api",
    repoPath: "/tmp/api",
    branch: "feat/x",
    title: "A session",
    status: "idle",
    cli: "claude",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    worktreePath: "/tmp/s1",
    baseBranch: "main",
    mode: "auto",
    ...over
  }) as Session

/** Throws on every render, the way a plugin with a real bug does. */
const AlwaysThrows = () => {
  throw new Error("plugin exploded")
}

let errorSpy: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  // React logs caught boundary errors itself, and `componentDidCatch` logs one
  // more. Silenced so the run is readable — but COUNTED, because the count is
  // the assertion for the re-mount loop.
  errorSpy = vi.spyOn(console, "error").mockImplementation(() => {})
})

afterEach(() => {
  errorSpy.mockRestore()
  cleanup()
})

describe("PluginTabHost", () => {
  it("shows a card naming the plugin when its body throws", () => {
    render(
      <PluginTabHost pluginId="boom" reloadKey="boom@1.0.0" session={session()}>
        <AlwaysThrows />
      </PluginTabHost>
    )
    expect(screen.getByTestId("plugin-error-boom")).toBeTruthy()
    expect(screen.getByText("plugin exploded")).toBeTruthy()
  })

  it("does NOT re-mount the plugin when only the parent re-rendered", () => {
    const { rerender } = render(
      <PluginTabHost pluginId="boom" reloadKey="boom@1.0.0" session={session()}>
        <AlwaysThrows />
      </PluginTabHost>
    )
    const afterFirstThrow = errorSpy.mock.calls.length

    // A fresh <AlwaysThrows /> element every time, exactly as the registry's
    // `render` closure produces. Same plugin, same build, same session.
    for (let i = 0; i < 5; i++) {
      rerender(
        <PluginTabHost pluginId="boom" reloadKey="boom@1.0.0" session={session()}>
          <AlwaysThrows />
        </PluginTabHost>
      )
    }

    // The card stayed up, and nothing threw again. Under the old `children`
    // test this logged another stack per re-render.
    expect(screen.getByTestId("plugin-error-boom")).toBeTruthy()
    expect(errorSpy.mock.calls.length).toBe(afterFirstThrow)
  })

  it("clears the card when the plugin's version changes, so a rebuild is retried", () => {
    const { rerender } = render(
      <PluginTabHost pluginId="boom" reloadKey="boom@1.0.0" session={session()}>
        <AlwaysThrows />
      </PluginTabHost>
    )
    expect(screen.getByTestId("plugin-error-boom")).toBeTruthy()

    // The author fixed it and bumped the version — the documented way to force
    // a reload, and the one signal that the code is genuinely different.
    rerender(
      <PluginTabHost pluginId="boom" reloadKey="boom@1.0.1" session={session()}>
        <div data-testid="fixed">fixed</div>
      </PluginTabHost>
    )
    expect(screen.getByTestId("fixed")).toBeTruthy()
    expect(screen.queryByTestId("plugin-error-boom")).toBeNull()
  })

  it("clears the card when the operator switches to another session", () => {
    const { rerender } = render(
      <PluginTabHost pluginId="boom" reloadKey="boom@1.0.0" session={session()}>
        <AlwaysThrows />
      </PluginTabHost>
    )
    expect(screen.getByTestId("plugin-error-boom")).toBeTruthy()

    // A stale failure should not follow the operator into a different session:
    // the plugin may well work there, and the card would be a lie about it.
    rerender(
      <PluginTabHost
        pluginId="boom"
        reloadKey="boom@1.0.0"
        session={session({ id: "s2" })}
      >
        <div data-testid="other-session">ok here</div>
      </PluginTabHost>
    )
    expect(screen.getByTestId("other-session")).toBeTruthy()
  })
})
