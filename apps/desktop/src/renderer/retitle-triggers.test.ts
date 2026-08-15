import type { Session, SessionActivity } from "@jingler/core"
import { describe, expect, it } from "vitest"
import {
  needsSessionRetitle,
  newlyPlannedSessionIds,
  newlyStartedSessionIds
} from "./retitle-triggers.js"

/**
 * `newlyPlannedSessionIds` is the pure trigger for retitling a session right
 * after planning. We assert it fires only on the absent → present edge (a plan
 * just appeared) and only for auto-named sessions — so a title updates once
 * there's a plan, but a manually-named session is never touched and an existing
 * plan doesn't re-fire on every render.
 */

const session = (
  id: string,
  autoTitle?: boolean,
  semanticBranchPending?: boolean
): Pick<Session, "id" | "autoTitle" | "semanticBranchPending"> => ({
  id,
  autoTitle,
  semanticBranchPending
})

describe("newlyPlannedSessionIds", () => {
  const sessions = [session("a", true), session("b", true), session("c", false)]

  it("fires for an auto-named session whose plan just appeared", () => {
    expect(newlyPlannedSessionIds(new Set(), new Set(["a"]), sessions)).toStrictEqual(["a"])
  })

  it("does NOT re-fire for a plan that was already present", () => {
    expect(newlyPlannedSessionIds(new Set(["a"]), new Set(["a"]), sessions)).toStrictEqual([])
  })

  it("excludes a manually-named (pinned) session even when its plan just appeared", () => {
    expect(newlyPlannedSessionIds(new Set(), new Set(["c"]), sessions)).toStrictEqual([])
  })

  it("does not fire when a plan is removed (present → absent)", () => {
    expect(newlyPlannedSessionIds(new Set(["a"]), new Set(), sessions)).toStrictEqual([])
  })

  it("returns only the newly-added ids when several change at once", () => {
    expect(newlyPlannedSessionIds(new Set(["a"]), new Set(["a", "b"]), sessions)).toStrictEqual(["b"])
  })

  it("fires for a pinned title whose fresh worktree still needs a branch", () => {
    const pinnedPending = [session("p", false, true)]
    expect(newlyPlannedSessionIds(new Set(), new Set(["p"]), pinnedPending)).toStrictEqual(["p"])
    expect(needsSessionRetitle(pinnedPending[0])).toBe(true)
  })
})

describe("newlyStartedSessionIds", () => {
  const activity: SessionActivity = { kind: "thinking", verb: "Thinking", target: "" }
  const sessions = [
    session("fresh", true, true),
    session("named", true, false),
    session("pinnedFresh", false, true)
  ]

  it("fires when a branch-pending session's run just started", () => {
    expect(newlyStartedSessionIds({}, { fresh: activity }, sessions)).toStrictEqual(["fresh"])
  })

  it("also fires for a pinned title whose fresh worktree still needs its branch", () => {
    expect(
      newlyStartedSessionIds({}, { pinnedFresh: activity }, sessions)
    ).toStrictEqual(["pinnedFresh"])
  })

  it("stays quiet once the semantic branch exists — later turns only retitle on completion", () => {
    expect(newlyStartedSessionIds({}, { named: activity }, sessions)).toStrictEqual([])
  })

  it("does NOT re-fire while the run stays live, nor on the completion edge", () => {
    expect(
      newlyStartedSessionIds({ fresh: activity }, { fresh: activity }, sessions)
    ).toStrictEqual([])
    expect(newlyStartedSessionIds({ fresh: activity }, {}, sessions)).toStrictEqual([])
  })
})
