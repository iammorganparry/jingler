// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { useEffect, useState, type ReactNode } from "react"
import type { Session } from "@starbase/core"
import {
  useCommand,
  useHost,
  usePluginStorage,
  useSession
} from "@starbase/plugin-sdk"
import { PluginTabHost } from "./plugin-tab-host.js"

/**
 * The wiring test: does a plugin's view actually WORK?
 *
 * Every other test in this area checks one link — the protocol serves a file,
 * the loader refuses a bad module, the registry caches by version. None of them
 * would catch the failure this file exists for, which is that the links do not
 * join up: `useHost()` was written against a global nothing published, so every
 * plugin would have thrown on its first line while all the unit tests passed.
 *
 * So this mounts a plugin view the way the app does and calls the real hooks.
 */

vi.mock("./rpc-client.js", () => ({
  rpc: {
    pluginsInvoke: vi.fn(async (_pluginId: string, commandId: string, arg?: unknown) => ({
      commandId,
      arg
    })),
    pluginsStorageGet: vi.fn(async () => "stored-value"),
    pluginsStorageSet: vi.fn(async () => undefined),
    pluginsStorageDelete: vi.fn(async () => undefined),
    pluginsStorageKeys: vi.fn(async () => ["a", "b"])
  }
}))

afterEach(cleanup)

/**
 * A full internal `Session`, deliberately including the bookkeeping a plugin
 * must NOT see — that is what the narrowing test below asserts against.
 */
const internalSession = (over: Partial<Session> = {}): Session =>
  ({
    id: "s1",
    repo: "trigify/api",
    branch: "starbase/s1",
    title: "Fix auth",
    status: "idle",
    cli: "claude",
    diff: { added: 3, removed: 1 },
    prNumber: 42,
    costUsd: 0.42,
    tokens: 1234,
    updatedAt: "2026-07-16T00:00:00.000Z",
    createdAt: "2026-07-16T00:00:00.000Z",
    chats: [],
    activeChatId: "c1",
    worktreePath: "/tmp/s1",
    baseBranch: "main",
    mode: "auto",
    ...over
  }) as Session

/** Mounts a view the way `plugin-registry` does: inside the host, no props. */
const mountPlugin = (View: () => ReactNode, over: Partial<Session> = {}) =>
  render(
    <PluginTabHost pluginId="linear" session={internalSession(over)}>
      <View />
    </PluginTabHost>
  )

describe("a plugin view rendered the way the app renders it", () => {
  it("gets its session through useSession", () => {
    const View = () => {
      const session = useSession()
      return <div>repo: {session.repo}</div>
    }
    mountPlugin(View)
    expect(screen.getByText("repo: trigify/api")).toBeTruthy()
  })

  it("sees the narrowed snapshot, not Starbase's internal session", () => {
    // The contract the SDK documents. If the full `Session` leaked through,
    // every one of its ~25 fields would become a de-facto public API.
    const View = () => {
      const session = useSession()
      return <pre>{Object.keys(session).sort().join(",")}</pre>
    }
    mountPlugin(View)
    const keys = screen.getByText(/repo/).textContent ?? ""
    expect(keys.split(",")).toEqual(
      expect.arrayContaining(["branch", "cli", "id", "prNumber", "repo", "title"])
    )
    // Internal bookkeeping a plugin must never couple to.
    expect(keys).not.toContain("chats")
    expect(keys).not.toContain("createdAt")
    expect(keys).not.toContain("status")
  })

  it("reaches its host half through useHost().invoke", async () => {
    const View = () => {
      const host = useHost()
      const [result, setResult] = useState("")
      useEffect(() => {
        void host
          .invoke<{ commandId: string }>("linear.sync", { repo: "x" })
          .then((r) => setResult(r.commandId))
      }, [host])
      return <div>invoked: {result}</div>
    }
    mountPlugin(View)
    await waitFor(() => expect(screen.getByText("invoked: linear.sync")).toBeTruthy())
  })

  it("reads and writes its own storage", async () => {
    const View = () => {
      const store = usePluginStorage()
      const [value, setValue] = useState("")
      useEffect(() => {
        void store.get<string>("k").then((v) => setValue(v ?? "missing"))
      }, [store])
      return <div>stored: {value}</div>
    }
    mountPlugin(View)
    await waitFor(() => expect(screen.getByText("stored: stored-value")).toBeTruthy())
  })

  it("binds a command with useCommand", async () => {
    const View = () => {
      const sync = useCommand<{ commandId: string }>("linear.sync")
      const [done, setDone] = useState("")
      useEffect(() => {
        void sync().then((r) => setDone(r.commandId))
      }, [sync])
      return <div>ran: {done}</div>
    }
    mountPlugin(View)
    await waitFor(() => expect(screen.getByText("ran: linear.sync")).toBeTruthy())
  })

  it("shows a named failure card when the view throws, not a blank window", () => {
    const Boom = () => {
      throw new Error("plugin exploded")
    }
    // React logs caught render errors; the card is the assertion, not the noise.
    const spy = vi.spyOn(console, "error").mockImplementation(() => {})
    mountPlugin(Boom)
    expect(screen.getByTestId("plugin-error-linear")).toBeTruthy()
    expect(screen.getByText(/plugin exploded/)).toBeTruthy()
    spy.mockRestore()
  })
})

describe("a plugin hook called outside a plugin view", () => {
  it("throws an error that names the mistake", () => {
    // Otherwise this is `Cannot read properties of null`, several frames into
    // someone else's component, naming nothing that would help.
    const Stray = () => {
      useHost()
      return null
    }
    const spy = vi.spyOn(console, "error").mockImplementation(() => {})
    expect(() => render(<Stray />)).toThrow(/outside a Starbase plugin view/)
    spy.mockRestore()
  })
})
