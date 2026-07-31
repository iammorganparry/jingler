import { describe, expect, it } from "vitest"
import {
  createPlanDraftStream,
  extractPlanDraft
} from "./plan-draft-stream.js"

describe("extractPlanDraft", () => {
  it("sanitizes incomplete cumulative HTML from the top-level protocol fence", () => {
    expect(
      extractPlanDraft(
        // biome-ignore lint/security/noSecrets: Static plan-protocol test fixture.
        "````html\n<h1>PRD: Streamed</h1><p onclick=\"bad()\">Growing"
      )
    ).toEqual({
      source: "<h1>PRD: Streamed</h1><p>Growing</p>",
      complete: false
    })
  })

  it("recognises a closed legacy html-plan info string", () => {
    expect(
      extractPlanDraft(
        "````html plan\n<h1>PRD: Compatible</h1>\n````"
      )
    ).toEqual({
      source: "<h1>PRD: Compatible</h1>",
      complete: true
    })
  })

  it("does not interpret prose, triple-fenced HTML, or unrelated later examples as a plan", () => {
    expect(extractPlanDraft("<h1>ordinary assistant HTML</h1>")).toBeNull()
    expect(
      // biome-ignore lint/security/noSecrets: Static plan-protocol test fixture.
      extractPlanDraft("```html\n<h1>ordinary example</h1>\n```")
    ).toBeNull()
    expect(
      extractPlanDraft(
        "Here is an example:\n\n````html\n<h1>Not the protocol block</h1>\n````"
      )
    ).toBeNull()
  })

  it("tolerates a prose preamble when the fenced document has a plan title", () => {
    expect(
      extractPlanDraft(
        // biome-ignore lint/security/noSecrets: Static plan-protocol test fixture.
        "The complete plan follows.\n\n````html\n<h1>PRD: Real plan</h1>"
      )
    ).toEqual({
      source: "<h1>PRD: Real plan</h1>",
      complete: false
    })
  })
})

describe("createPlanDraftStream", () => {
  it("emits changed cumulative snapshots for deltas and marks the closed fence complete", () => {
    const stream = createPlanDraftStream(() => "plan-1", { minIntervalMs: 0 })
    expect(stream.append("````html\n")).toBeNull()
    expect(stream.append("<h1>PRD: Live")).toEqual({
      _tag: "PlanDraft",
      draft: {
        id: "plan-1",
        source: "<h1>PRD: Live</h1>",
        phase: "composing"
      }
    })
    expect(stream.append("</h1><p>More</p>")).toEqual({
      _tag: "PlanDraft",
      draft: {
        id: "plan-1",
        source: "<h1>PRD: Live</h1><p>More</p>",
        phase: "composing"
      }
    })
    expect(stream.append("\n````")).toEqual({
      _tag: "PlanDraft",
      draft: {
        id: "plan-1",
        source: "<h1>PRD: Live</h1><p>More</p>",
        phase: "complete"
      }
    })
  })

  it("coalesces rapid token deltas and always emits the completed document", () => {
    let now = 0
    const stream = createPlanDraftStream(() => "plan-throttled", {
      now: () => now
    })
    // biome-ignore lint/security/noSecrets: Static plan-protocol test fixture.
    expect(stream.append("````html\n<h1>PRD: Live")).toMatchObject({
      _tag: "PlanDraft"
    })

    for (const token of ["</h1>", "<p>", "one ", "two ", "three", "</p>"]) {
      expect(stream.append(token)).toBeNull()
    }

    now = 50
    expect(stream.append("<p>next</p>")).toMatchObject({
      _tag: "PlanDraft",
      draft: { source: expect.stringContaining("<p>next</p>") }
    })

    // Completion bypasses the cadence so the final source cannot be stranded.
    expect(stream.append("\n````")).toMatchObject({
      _tag: "PlanDraft",
      draft: { phase: "complete" }
    })
  })

  it("deduplicates cumulative provider updates and emits one visible clear", () => {
    const stream = createPlanDraftStream(() => "plan-2")
    // biome-ignore lint/security/noSecrets: Static plan-protocol test fixture.
    const message = "````html\n<h1>PRD: Cumulative</h1>"
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
})
