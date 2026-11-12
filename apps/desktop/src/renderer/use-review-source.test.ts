import { describe, expect, it, vi } from "vitest"

vi.mock("./rpc-client.js", () => ({ rpc: {} }))
import { availableReviewSource, reviewPrNumber } from "./use-review.js"
import type { Session } from "@jingler/core"

describe("reviewPrNumber", () => {
  // The agent opened #7 in api, then switch_checkout'd into web, which has no PR.
  const session = {
    id: "s",
    activeCheckoutId: "web",
    checkouts: [
      { id: "api", repo: "api", repoPath: "/api", worktreePath: "/wt/api", branch: "a", prNumber: 7, prs: [{ number: 7 }] },
      { id: "web", repo: "web", repoPath: "/web", worktreePath: "/wt/web", branch: "b", prNumber: null }
    ]
  } as unknown as Session

  it("reads another repo's PR when the active checkout has none", () => {
    expect(reviewPrNumber(session, undefined, null)).toBe(7)
  })
  it("reads the named checkout's own PR", () => {
    expect(reviewPrNumber(session, "web", null)).toBeNull()
    expect(reviewPrNumber(session, "api", null)).toBe(7)
  })
  it("prefers the chosen stack layer", () => {
    expect(reviewPrNumber(session, undefined, 3)).toBe(3)
  })
})

describe("availableReviewSource", () => {
  it("keeps an empty local source local even when the PR has files", () => {
    expect(availableReviewSource("local", true, false)).toBe("local")
  })
  it("falls back from an empty PR source to local changes", () => {
    expect(availableReviewSource("pr", false, true)).toBe("local")
  })
})
