import { expect, it } from "vitest"
import { testSession } from "../test-support.js"
import { deriveHomeCards } from "./home-cards-model.js"

const sessions = [testSession({ id: "a", title: "A" }), testSession({ id: "b", title: "B" }), testSession({ id: "c", title: "C", archived: true })]
const none = new Set<string>()

it("derives needs-you cards from needs-input / needs-approval and running rows from other activities", () => {
  const out = deriveHomeCards({
    sessions,
    liveActivity: { a: { kind: "needs-approval", verb: "Needs approval", target: null }, b: { kind: "running", verb: "Running", target: "npm test" }, c: { kind: "needs-input", verb: "Needs input", target: null } },
    seen: none,
    dismissed: none
  })
  expect(out.needsYou).toEqual([{ sessionId: "a", title: "A", text: "Needs approval", stale: false }])
  expect(out.running).toEqual([{ sessionId: "b", title: "B", activity: "Running npm test" }])
})

it("turns a previously seen card stale once nothing is pending, until dismissed", () => {
  const input = { sessions, liveActivity: {}, seen: new Set(["a"]) }
  expect(deriveHomeCards({ ...input, dismissed: none }).needsYou).toEqual([{ sessionId: "a", title: "A", text: "", stale: true }])
  expect(deriveHomeCards({ ...input, dismissed: new Set(["a"]) }).needsYou).toEqual([])
})
