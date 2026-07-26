/**
 * The bridge's scoping rules, and the one place it reaches the app's own state.
 *
 * `sessions.unlinkIssue` is the odd one out here: `invoke` and `storage` are
 * closed over a plugin id and can only reach that plugin's things, while this
 * mutates a session the app owns. What it must not do is mutate it and stop
 * there — the record has to be republished through `session-updates`, or the
 * write lands on disk and every view keeps rendering the stale session until
 * the app restarts. That is the assertion below, and it is the half that was
 * missing when the capability was lost in the plugin migration.
 */
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { Session } from "@starbase/core"

const sessionsUnlinkIssue = vi.fn()

vi.mock("./rpc-client.js", () => ({
  rpc: {
    pluginsInvoke: vi.fn(async () => undefined),
    pluginsStorageGet: vi.fn(async () => null),
    pluginsStorageSet: vi.fn(async () => undefined),
    pluginsStorageDelete: vi.fn(async () => undefined),
    pluginsStorageKeys: vi.fn(async () => []),
    sessionsUnlinkIssue: (id: string) => sessionsUnlinkIssue(id)
  }
}))

const { pluginBridge } = await import("./plugin-bridge.js")
const { onSessionUpdate } = await import("./session-updates.js")

const unlinked = { id: "s1", repo: "widget", issueNumber: null } as unknown as Session

beforeEach(() => {
  sessionsUnlinkIssue.mockReset()
  sessionsUnlinkIssue.mockResolvedValue(unlinked)
})

describe("sessions.unlinkIssue", () => {
  it("calls the RPC with the session id the plugin named", async () => {
    await pluginBridge("some-plugin").sessions.unlinkIssue("s1")
    expect(sessionsUnlinkIssue).toHaveBeenCalledWith("s1")
  })

  it("republishes the updated record, so the app's state does not go stale", async () => {
    const seen: Session[] = []
    const off = onSessionUpdate((s) => seen.push(s))

    await pluginBridge("some-plugin").sessions.unlinkIssue("s1")

    // Without this the RPC's return value is dropped on the floor: the session
    // is unlinked on disk and the sidebar, the tab bar and the plugin's own
    // `useSession` all keep the pre-write record until the next launch.
    expect(seen).toEqual([unlinked])
    off()
  })

  it("is the same object for every plugin, so it is dependency-array safe", () => {
    // `useSessionActions` returns this straight through. A fresh object per
    // bridge would give every consumer a new identity for no gain.
    expect(pluginBridge("a").sessions).toBe(pluginBridge("b").sessions)
  })
})

describe("openExternal", () => {
  it("refuses a non-http(s) URL at the caller's side of the boundary", async () => {
    // Checked here as well as in main. "The main process validates it" is a poor
    // answer when the check is one call away from untrusted code.
    await expect(
      pluginBridge("some-plugin").openExternal("file:///etc/passwd")
    ).rejects.toThrow(/refused a non-http\(s\) URL/)
  })
})
