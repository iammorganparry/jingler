import type { AssetPayload } from "@jingler/core"
import { describe, expect, it, vi } from "vitest"

// `use-file-browser` reaches `rpc-client`, whose protocol layer binds `window` at
// import — undefined under node. This test only exercises the pure guard, so a
// bare stub keeps that binding from running.
vi.mock("./rpc-client.js", () => ({ rpc: {} }))

import type { FileBrowserActor } from "./use-file-browser.js"
import { isFileBrowserActorPinned } from "./use-file-browser.js"

/**
 * `isFileBrowserActorPinned` only reads `getSnapshot().matches(...)` and
 * `.context.{draft,payload}`, so a shaped stub exercises the guard without
 * standing up a real machine (which would need the worktree RPC surface).
 */
const stub = (opts: {
  saving?: boolean
  draft?: string | null
  payload?: AssetPayload | null
}): FileBrowserActor =>
  ({
    getSnapshot: () => ({
      matches: () => opts.saving === true,
      context: { draft: opts.draft ?? null, payload: opts.payload ?? null }
    })
  }) as unknown as FileBrowserActor

const textPayload = (text: string): AssetPayload => ({ text }) as unknown as AssetPayload

describe("isFileBrowserActorPinned", () => {
  it("pins a mounted actor without even inspecting its state", () => {
    // Evicting it would blank a browser the operator is looking at.
    expect(isFileBrowserActorPinned(stub({}), true)).toBe(true)
  })

  it("pins an unmounted actor that is mid-save", () => {
    expect(isFileBrowserActorPinned(stub({ saving: true }), false)).toBe(true)
  })

  it("pins an unmounted actor holding a dirty draft", () => {
    // The edit exists only in the actor; dropping it loses the operator's work.
    expect(
      isFileBrowserActorPinned(stub({ draft: "edited", payload: textPayload("original") }), false)
    ).toBe(true)
  })

  it("does not pin an unmounted actor whose draft matches the file", () => {
    expect(
      isFileBrowserActorPinned(stub({ draft: "same", payload: textPayload("same") }), false)
    ).toBe(false)
  })

  it("pins a draft with no text payload to compare against", () => {
    expect(isFileBrowserActorPinned(stub({ draft: "edited", payload: null }), false)).toBe(true)
  })

  it("does not pin a clean, unmounted actor", () => {
    // Nothing unrecoverable — it re-creates from disk on the next visit.
    expect(isFileBrowserActorPinned(stub({}), false)).toBe(false)
  })
})
