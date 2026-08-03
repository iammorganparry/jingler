import { describe, expect, it } from "vitest"
import {
  createPlanDraftStream,
  extractPlanDraft
} from "./plan-draft-stream.js"

/** A plan emission body — the `"mode":` discriminant is what marks it a plan. */
const body = (title: string): string =>
  `{"mode":"submit","plan":{"title":${JSON.stringify(title)},"sections":[],"stages":[],"annotations":[]}}`

describe("extractPlanDraft", () => {
  it("returns the still-incomplete cumulative JSON verbatim from the protocol fence", () => {
    expect(
      extractPlanDraft('```json\n{"mode":"submit","plan":{"title":"PRD: Streamed"')
    ).toEqual({
      source: '{"mode":"submit","plan":{"title":"PRD: Streamed"',
      complete: false
    })
  })

  it("recognises a closed plan-emission block", () => {
    expect(extractPlanDraft(`\`\`\`json\n${body("PRD: Compatible")}\n\`\`\``)).toEqual({
      source: body("PRD: Compatible"),
      complete: true
    })
  })

  it("does not interpret prose, a non-plan JSON block, or unrelated later examples as a plan", () => {
    expect(extractPlanDraft("Just some ordinary assistant prose.")).toBeNull()
    // A ```json block without the `"mode":` discriminant is an illustration.
    expect(extractPlanDraft('```json\n{ "some": "other data" }\n```')).toBeNull()
    expect(
      extractPlanDraft(`Here is an example:\n\n\`\`\`json\n${body("PRD: Example")}\n\`\`\``)
    ).not.toBeNull()
  })

  it("tolerates a prose preamble before the fenced plan document", () => {
    expect(
      extractPlanDraft('The complete plan follows.\n\n```json\n{"mode":"submit","plan":{"title":"PRD: Real plan"')
    ).toEqual({
      source: '{"mode":"submit","plan":{"title":"PRD: Real plan"',
      complete: false
    })
  })
})

describe("createPlanDraftStream", () => {
  it("emits changed cumulative snapshots for deltas and marks the closed fence complete", () => {
    const stream = createPlanDraftStream(() => "plan-1", { minIntervalMs: 0 })
    expect(stream.append("```json\n")).toBeNull()
    expect(stream.append('{"mode":"submit","plan":{"title":"PRD: Live"')).toEqual({
      _tag: "PlanDraft",
      draft: {
        id: "plan-1",
        source: '{"mode":"submit","plan":{"title":"PRD: Live"',
        phase: "composing"
      }
    })
    expect(stream.append(',"stages":[]}}')).toEqual({
      _tag: "PlanDraft",
      draft: {
        id: "plan-1",
        source: '{"mode":"submit","plan":{"title":"PRD: Live","stages":[]}}',
        phase: "composing"
      }
    })
    expect(stream.append("\n```")).toEqual({
      _tag: "PlanDraft",
      draft: {
        id: "plan-1",
        source: '{"mode":"submit","plan":{"title":"PRD: Live","stages":[]}}',
        phase: "complete"
      }
    })
  })

  it("coalesces rapid token deltas and always emits the completed document", () => {
    let now = 0
    const stream = createPlanDraftStream(() => "plan-throttled", {
      now: () => now
    })
    expect(stream.append('```json\n{"mode":"submit","plan":{"title":"PRD: Live"')).toMatchObject({
      _tag: "PlanDraft"
    })

    for (const token of [',"sections":', "[", "]", ',"stages":', "["]) {
      expect(stream.append(token)).toBeNull()
    }

    now = 50
    expect(stream.append('{"id":"01"}]')).toMatchObject({
      _tag: "PlanDraft",
      draft: { source: expect.stringContaining('{"id":"01"}]') }
    })

    // Completion bypasses the cadence so the final source cannot be stranded.
    expect(stream.append("}}\n```")).toMatchObject({
      _tag: "PlanDraft",
      draft: { phase: "complete" }
    })
  })

  it("deduplicates cumulative provider updates and emits one visible clear", () => {
    const stream = createPlanDraftStream(() => "plan-2")
    const message = `\`\`\`json\n${body("PRD: Cumulative")}`
    expect(stream.update(message)?._tag).toBe("PlanDraft")
    expect(stream.update(message)).toBeNull()
    expect(stream.clear()).toEqual({
      _tag: "PlanDraft",
      draft: {
        id: "plan-2",
        source: "",
        phase: "cleared"
      }
    })
    expect(stream.clear()).toBeNull()
  })

  it("clears a visible draft when a cumulative provider rewrite removes the plan", () => {
    const stream = createPlanDraftStream(() => "plan-rewritten")
    expect(stream.update(`\`\`\`json\n${body("PRD: Superseded")}`)).toMatchObject({
      _tag: "PlanDraft",
      draft: { phase: "composing" }
    })

    expect(stream.update("I need to reconsider the approach.")).toEqual({
      _tag: "PlanDraft",
      draft: {
        id: "plan-rewritten",
        source: "",
        phase: "cleared"
      }
    })
    expect(stream.update("Still reconsidering.")).toBeNull()

    expect(stream.update(`\`\`\`json\n${body("PRD: Replacement")}`)).toMatchObject({
      _tag: "PlanDraft",
      draft: {
        source: expect.stringContaining("PRD: Replacement"),
        phase: "composing"
      }
    })
  })
})
