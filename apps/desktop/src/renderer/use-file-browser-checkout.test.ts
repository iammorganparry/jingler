import { describe, expect, it, vi } from "vitest"

const rpc = vi.hoisted(() => ({
  sessionsFileDiff: vi.fn().mockResolvedValue({ kind: "patch", patch: "" }),
  assetRead: vi.fn().mockResolvedValue({ kind: "text", path: "README.md", text: "x", revision: "r" }),
  assetWrite: vi.fn()
}))
vi.mock("./rpc-client.js", () => ({ rpc }))

import { fileSurfaceId, openSessionFileDiff, parseFileSurface } from "./use-file-browser.js"

describe("checkout-bound file editors", () => {
  it("reads and diffs a non-active checkout's file against that checkout", async () => {
    openSessionFileDiff("s1", "/api", "README.md", undefined, "api")
    await vi.waitFor(() => expect(rpc.assetRead).toHaveBeenCalledWith("s1", "README.md", "api"))
    await vi.waitFor(() => expect(rpc.sessionsFileDiff).toHaveBeenCalledWith("s1", "README.md", "api"))
  })

  it("keeps the active checkout's call unbound", async () => {
    openSessionFileDiff("s2", "/web", "README.md")
    await vi.waitFor(() => expect(rpc.assetRead).toHaveBeenCalledWith("s2", "README.md", undefined))
  })

  it("gives same-named files of two checkouts distinct tab ids that parse back", () => {
    expect(fileSurfaceId("README.md", "api")).not.toBe(fileSurfaceId("README.md"))
    expect(parseFileSurface(fileSurfaceId("docs/README.md", "api"))).toEqual({ path: "docs/README.md", checkoutId: "api" })
    expect(parseFileSurface("docs/README.md")).toEqual({ path: "docs/README.md" })
  })
})
