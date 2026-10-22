import { describe, expect, it } from "vitest"
import { createActor } from "xstate"
import { addedDrafts, composeReviewBody, draftsToReviewComments, promotionSummary, loadDecisions, reviewDrawerMachine, saveDecisions, undecidedDrafts, type ReviewFindingDraft } from "./review-drawer-machine.js"

const drafts: ReadonlyArray<ReviewFindingDraft> = [
  { id: "a", severity: "issue", path: "src/a.ts", line: 4, body: "Null deref." },
  { id: "b", severity: "nit", path: "src/b.ts", line: 9, body: "Rename." }
]
const start = () => {
  const actor = createActor(reviewDrawerMachine, { input: {} }).start()
  actor.send({ type: "SET_DRAFTS", drafts })
  return actor
}

describe("reviewDrawerMachine", () => {
  it("opens, moves to reviewing while drafts are undecided, and closes", () => {
    const actor = start()
    expect(actor.getSnapshot().value).toBe("closed")
    actor.send({ type: "OPEN" })
    expect(actor.getSnapshot().value).toBe("reviewing")
    actor.send({ type: "CLOSE" })
    expect(actor.getSnapshot().value).toBe("closed")
  })

  it("is plain open with no drafts", () => {
    const actor = createActor(reviewDrawerMachine, { input: {} }).start()
    actor.send({ type: "TOGGLE" })
    expect(actor.getSnapshot().value).toBe("open")
  })

  it("keeps drafts and decisions across close/reopen", () => {
    const actor = start()
    actor.send({ type: "OPEN" })
    actor.send({ type: "ADD", id: "a" })
    actor.send({ type: "CLOSE" })
    actor.send({ type: "OPEN" })
    const { context } = actor.getSnapshot()
    expect(addedDrafts(context).map((d) => d.id)).toEqual(["a"])
    expect(undecidedDrafts(context).map((d) => d.id)).toEqual(["b"])
  })

  it("settles to open once every draft is added or dismissed, and ADD_ALL adds the rest", () => {
    const actor = start()
    actor.send({ type: "OPEN" })
    actor.send({ type: "DISMISS", id: "b" })
    actor.send({ type: "ADD_ALL" })
    expect(addedDrafts(actor.getSnapshot().context).map((d) => d.id)).toEqual(["a"])
    expect(actor.getSnapshot().value).toBe("open")
  })

  it("promotes, and SUBMITTED clears the pending comments", () => {
    const actor = start()
    actor.send({ type: "OPEN" })
    actor.send({ type: "ADD_ALL" })
    actor.send({ type: "PROMOTE" })
    expect(actor.getSnapshot().value).toBe("promoted")
    actor.send({ type: "SUBMITTED" })
    expect(actor.getSnapshot().context.added).toEqual([])
    expect(undecidedDrafts(actor.getSnapshot().context)).toEqual([])
  })

  it("promotion summary carries added and undecided drafts but not dismissed ones", () => {
    const actor = start()
    actor.send({ type: "OPEN" })
    actor.send({ type: "ADD", id: "a" })
    actor.send({ type: "DISMISS", id: "b" })
    actor.send({ type: "PROMOTE" })
    expect(actor.getSnapshot().value).toBe("promoted")
    const summary = promotionSummary({ number: 7, title: "T" }, actor.getSnapshot().context)
    expect(summary).toContain("PR #7")
    expect(summary).toContain("`src/a.ts:4`")
    expect(summary).not.toContain("src/b.ts")
  })

  it("maps drafts to inline review comments", () => {
    expect(draftsToReviewComments(drafts)[0]).toEqual({ path: "src/a.ts", line: 4, startLine: null, body: "**Issue** — Null deref." })
  })

  it("composes pending inline comments after the operator's text", () => {
    expect(composeReviewBody("LGTM", drafts)).toBe(
      "LGTM\n\n- **Issue** `src/a.ts:4` — Null deref.\n\n- **Nit** `src/b.ts:9` — Rename."
    )
  })
})

describe("reviewDrawerMachine run status", () => {
  it("tracks running, failed with error, and retry back to running", () => {
    const actor = createActor(reviewDrawerMachine, { input: {} }).start()
    expect(actor.getSnapshot().context.run).toBe("idle")
    actor.send({ type: "RUN", status: "running" })
    expect(actor.getSnapshot().context.run).toBe("running")
    actor.send({ type: "RUN", status: "failed", error: "boom" })
    expect(actor.getSnapshot().context).toMatchObject({ run: "failed", error: "boom" })
    actor.send({ type: "RUN", status: "running" })
    expect(actor.getSnapshot().context).toMatchObject({ run: "running", error: null })
  })

  it("restores saved decisions for a PR key", () => {
    saveDecisions("a/b#1", { ...createActor(reviewDrawerMachine, { input: {} }).start().getSnapshot().context, added: ["x"], dismissed: ["y"] })
    const actor = createActor(reviewDrawerMachine, { input: loadDecisions("a/b#1") }).start()
    expect(actor.getSnapshot().context).toMatchObject({ added: ["x"], dismissed: ["y"] })
    expect(loadDecisions("other#2")).toEqual({ added: [], dismissed: [] })
  })
})
