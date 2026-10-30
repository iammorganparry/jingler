import { Session as SessionSchema, type PrState, type Session, type SessionPrStatus } from "@jingler/core"
import { Schema } from "effect"
import { describe, expect, it } from "vitest"
import {
  issuesToCloseOnMerge,
  prNotifyKey,
  prNumbersOf,
  prsToNotify,
  prTargetsOf,
  stackLifecycle,
  worstPrStatus,
  type PrLayer
} from "./pr-sweep.js"

/**
 * `issuesToCloseOnMerge` is all that survives of what used to be the "archive
 * sweep". The regression it guards: a merged PR used to auto-archive its whole
 * session, but a session holds ONE `prNumber` while routinely outliving several
 * PRs — so merging the first one made a live multi-PR session vanish from the
 * sidebar mid-flight. Merge state now only badges the row; the ONLY action left
 * on merge is closing an opted-in linked issue.
 */

const session = (over: Record<string, unknown> & { id: string }): Session =>
  Schema.decodeUnknownSync(SessionSchema)({
    repo: "r",
    branch: `chore/${over.id}`,
    title: over.id,
    status: "idle",
    diff: { added: 0, removed: 0 },
    prNumber: 1,
    costUsd: 0,
    tokens: 0,
    updatedAt: "2026-07-18T00:00:00.000Z",
    worktreePath: `/tmp/${over.id}`,
    chats: [{ id: `c_${over.id}`, title: null, createdAt: "2026-07-18T00:00:00.000Z", updatedAt: "2026-07-18T00:00:00.000Z" }],
    activeChatId: `c_${over.id}`,
    ...over
  })

/** A session wired for the automation: linked issue + the opt-in flag. */
const optedIn = (id: string) =>
  session({ id, issueNumber: 7, automations: { progressComments: false, closeOnMerge: true } })

const none = new Set<string>()

describe("issuesToCloseOnMerge", () => {
  it("closes the linked issue of an opted-in session whose PR merged", () => {
    expect(issuesToCloseOnMerge({ a: "merged" }, [optedIn("a")], none)).toStrictEqual(["a"])
  })

  it("closes a provider-neutral GitHub link written by current sessions", () => {
    const current = session({
      id: "a",
      linkedIssue: {
        providerId: "github",
        id: "7",
        identifier: "#7",
        url: "https://github.com/acme/widget/issues/7",
        title: "Current link",
        labels: []
      },
      automations: { progressComments: false, closeOnMerge: true }
    })
    expect(issuesToCloseOnMerge({ a: "merged" }, [current], none)).toStrictEqual(["a"])
  })

  it("keeps GitHub close automation when a Linear link is selected", () => {
    const current = session({
      id: "a",
      linkedIssues: [
        {
          providerId: "github",
          id: "7",
          identifier: "#7",
          url: "https://github.com/acme/widget/issues/7",
          title: "GitHub link",
          labels: []
        },
        {
          providerId: "linear",
          id: "linear-7",
          identifier: "ENG-7",
          url: "https://linear.app/acme/issue/ENG-7",
          title: "Selected Linear link",
          labels: []
        }
      ],
      selectedIssue: { providerId: "linear", id: "linear-7" },
      automations: { progressComments: false, closeOnMerge: true }
    })
    expect(issuesToCloseOnMerge({ a: "merged" }, [current], none)).toStrictEqual(["a"])
  })

  it("never sends a non-GitHub issue to the GitHub close automation", () => {
    const linear = session({
      id: "a",
      linkedIssue: {
        providerId: "linear",
        id: "opaque-id",
        identifier: "ENG-7",
        url: "https://linear.app/acme/issue/ENG-7",
        title: "Linear link",
        labels: []
      },
      automations: { progressComments: false, closeOnMerge: true }
    })
    expect(issuesToCloseOnMerge({ a: "merged" }, [linear], none)).toStrictEqual([])
  })

  it("does not close anything while the PR is still open or a draft", () => {
    const sessions = [optedIn("a")]
    expect(issuesToCloseOnMerge({ a: "open" }, sessions, none)).toStrictEqual([])
    expect(issuesToCloseOnMerge({ a: "draft" }, sessions, none)).toStrictEqual([])
  })

  it("does not close the issue when the PR was CLOSED rather than merged", () => {
    // Abandoning a PR says nothing about the issue — it may well still need doing.
    expect(issuesToCloseOnMerge({ a: "closed" }, [optedIn("a")], none)).toStrictEqual([])
  })

  it("respects the opt-in: a merged PR without closeOnMerge closes nothing", () => {
    const off = session({
      id: "a",
      issueNumber: 7,
      automations: { progressComments: true, closeOnMerge: false }
    })
    expect(issuesToCloseOnMerge({ a: "merged" }, [off], none)).toStrictEqual([])
  })

  it("ignores a session with no automations configured at all", () => {
    expect(issuesToCloseOnMerge({ a: "merged" }, [session({ id: "a", issueNumber: 7 })], none)).toStrictEqual([])
  })

  it("ignores an opted-in session that has no linked issue to close", () => {
    const noIssue = session({
      id: "a",
      automations: { progressComments: false, closeOnMerge: true }
    })
    expect(issuesToCloseOnMerge({ a: "merged" }, [noIssue], none)).toStrictEqual([])
  })

  it("fires once: a session already closed is never returned again", () => {
    // Load-bearing. A merged PR stays merged forever and the sweep polls on a
    // timer, so without this guard every tick would re-close the same issue.
    expect(issuesToCloseOnMerge({ a: "merged" }, [optedIn("a")], new Set(["a"]))).toStrictEqual([])
  })

  it("ignores a session with no PR state yet (nothing polled)", () => {
    expect(issuesToCloseOnMerge({}, [optedIn("a")], none)).toStrictEqual([])
  })

  it("reports every session that merged in the same tick", () => {
    const states: Record<string, PrState> = { a: "merged", b: "open", c: "merged" }
    const sessions = [optedIn("a"), optedIn("b"), optedIn("c")]
    expect(issuesToCloseOnMerge(states, sessions, none)).toStrictEqual(["a", "c"])
  })

  it("returns ONLY issue ids — merging never nominates a session for archiving", () => {
    // The behavioural heart of the fix, stated as an assertion: a merged PR on a
    // session with NO issue automation produces no work at all. There is no
    // longer any code path from "PR merged" to "session archived".
    const plain = session({ id: "multi-pr", prNumber: 204 })
    expect(issuesToCloseOnMerge({ "multi-pr": "merged" }, [plain], none)).toStrictEqual([])
  })
})

/**
 * `prsToNotify` decides which resolved PRs raise a desktop notification.
 *
 * The regression it guards is a lookup, not a policy: the first version indexed
 * this `Record<sessionId, PrState>` with the enclosing loop's numeric INDEX.
 * That is always `undefined` for a real session id, so the "PR merged/closed"
 * notification never fired — a whole kind the feature ships and exposes a
 * Settings toggle for was dead code. It typechecked, because TypeScript permits
 * numeric indexing of a `Record<string, T>`.
 */
describe("prsToNotify", () => {
  const status = (state: PrState, checks: SessionPrStatus["checks"] = null): SessionPrStatus => ({ state, checks })
  const layer = (number: number, state: PrState, checks: SessionPrStatus["checks"] = null, checkoutId = "primary"): PrLayer => ({
    checkoutId,
    number,
    status: status(state, checks)
  })
  const merged = session({ id: "s1" })
  const closed = session({ id: "s2" })
  const open = session({ id: "s3" })
  const stacks = { s1: [layer(1, "merged")], s2: [layer(2, "closed")], s3: [layer(3, "open")] }

  it("finds resolved PRs by SESSION ID, not by position", () => {
    // Reversed so a positional lookup can't accidentally agree.
    const out = prsToNotify(stacks, [open, closed, merged], new Set())
    expect(out.map((n) => [n.session.id, n.state])).toStrictEqual([
      ["s2", "closed"],
      ["s1", "merged"]
    ])
  })

  it("ignores a PR that is still open", () => {
    expect(prsToNotify(stacks, [open], new Set())).toStrictEqual([])
  })

  it("ignores a session whose PR state hasn't loaded yet", () => {
    expect(prsToNotify({}, [merged], new Set())).toStrictEqual([])
  })

  it("announces each resolution once — the poll re-runs every minute", () => {
    expect(prsToNotify(stacks, [merged], new Set([prNotifyKey("s1", "primary", 1)]))).toStrictEqual([])
  })

  it("a 3-PR stack produces 3 notifications, each keyed by (session, PR) and naming the layer above", () => {
    const stacked = session({ id: "st", prNumber: 482, prs: [{ number: 480 }, { number: 481 }, { number: 482 }] })
    const layers = { st: [layer(480, "merged"), layer(481, "merged"), layer(482, "closed")] }
    const seen = new Set<string>()
    const out = prsToNotify(layers, [stacked], seen)
    expect(out.map((n) => [n.number, n.state, n.stackedUnder])).toStrictEqual([
      [480, "merged", 481],
      [481, "merged", 482],
      [482, "closed", undefined]
    ])
    for (const n of out) seen.add(prNotifyKey("st", n.checkoutId, n.number))
    expect(prsToNotify(layers, [stacked], seen)).toStrictEqual([])
  })

  it("notifies per checkout", () => {
    const twoRepos = session({
      id: "mr",
      // The wire's top-level prNumber mirrors the active checkout's top PR.
      prNumber: 5,
      checkouts: [
        { id: "api", repo: "api", branch: "a", worktreePath: "/w/api", prNumber: 5 },
        { id: "web", repo: "web", branch: "b", worktreePath: "/w/web", prNumber: 5 }
      ],
      activeCheckoutId: "api"
    })
    expect(prTargetsOf(twoRepos)).toStrictEqual([
      { checkoutId: "api", number: 5 },
      { checkoutId: "web", number: 5 }
    ])
    const layers = { mr: [layer(5, "open", null, "api"), layer(5, "merged", null, "web")] }
    const seen = new Set<string>()
    const out = prsToNotify(layers, [twoRepos], seen)
    // Same PR number in two repos: only B's merge fires, under B's key, and is not "stacked under" A's PR.
    expect(out.map((n) => [n.checkoutId, n.number, n.state, n.stackedUnder])).toStrictEqual([["web", 5, "merged", undefined]])
    seen.add(prNotifyKey("mr", "web", 5))
    expect(prsToNotify(layers, [twoRepos], seen)).toStrictEqual([])
  })

  it("closes the issue only when every checkout PR is done", () => {
    const partial = stackLifecycle([layer(5, "open", null, "api"), layer(5, "merged", null, "web")])
    const done = stackLifecycle([layer(5, "closed", null, "api"), layer(5, "merged", null, "web")])
    expect(partial).toBe("open")
    expect(done).toBe("merged")
  })
})

describe("stack-aware sweep", () => {
  const layer = (number: number, state: PrState, checks: SessionPrStatus["checks"] = null): PrLayer => ({
    checkoutId: "primary",
    number,
    status: { state, checks }
  })

  it("polls every PR in prs bottom-first, and a pre-stack session as its single prNumber", () => {
    expect(prNumbersOf(session({ id: "a", prNumber: 3, prs: [{ number: 1 }, { number: 2 }, { number: 3 }] }))).toStrictEqual([1, 2, 3])
    expect(prNumbersOf(session({ id: "a", prNumber: 9 }))).toStrictEqual([9])
    expect(prNumbersOf(session({ id: "a", prNumber: null }))).toStrictEqual([])
  })

  it("stackLifecycle is merged only once every layer resolved, so the issue closes after the last merge", () => {
    expect(stackLifecycle([layer(1, "merged"), layer(2, "merged"), layer(3, "open")])).toBe("open")
    expect(stackLifecycle([layer(1, "merged"), layer(2, "merged"), layer(3, "merged")])).toBe("merged")
    expect(stackLifecycle([layer(1, "merged"), layer(2, "closed")])).toBe("merged")
    expect(stackLifecycle([layer(1, "closed"), layer(2, "closed")])).toBe("closed")
    expect(stackLifecycle([])).toBeUndefined()
  })

  it("closes the linked issue only after the last PR of the stack merges", () => {
    const stacked = session({
      id: "a",
      issueNumber: 7,
      automations: { progressComments: false, closeOnMerge: true },
      prs: [{ number: 1 }, { number: 2 }]
    })
    const partial = { a: stackLifecycle([layer(1, "merged"), layer(2, "open")])! }
    const done = { a: stackLifecycle([layer(1, "merged"), layer(2, "merged")])! }
    expect(issuesToCloseOnMerge(partial, [stacked], new Set())).toStrictEqual([])
    expect(issuesToCloseOnMerge(done, [stacked], new Set())).toStrictEqual(["a"])
  })

  it("worst layer wins: failing CI > closed > running/queued > passing, and merged never hides a failing upper layer", () => {
    expect(worstPrStatus([layer(1, "merged"), layer(2, "open", "pass"), layer(3, "open", "fail")])).toStrictEqual({ state: "open", checks: "fail" })
    expect(worstPrStatus([layer(1, "open", "pass"), layer(2, "closed"), layer(3, "open", "running")])).toStrictEqual({ state: "closed", checks: null })
    expect(worstPrStatus([layer(1, "open", "pass"), layer(2, "open", "pending"), layer(3, "open", "pass")])).toStrictEqual({ state: "open", checks: "pending" })
    expect(worstPrStatus([layer(1, "merged"), layer(2, "open", "pass")])).toStrictEqual({ state: "open", checks: "pass" })
    expect(worstPrStatus([layer(1, "merged"), layer(2, "merged")])).toStrictEqual({ state: "merged", checks: null })
    expect(worstPrStatus([])).toBeUndefined()
  })
})
