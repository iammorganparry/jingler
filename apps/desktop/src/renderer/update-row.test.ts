import { describe, expect, it } from "vitest"
import { updateRowView } from "./update-row.js"

describe("updateRowView", () => {
  it.each([
    [{ status: "available", version: "1.9.0" }, { version: "1.9.0", kind: "available" }],
    [{ status: "downloading", version: "1.9.0", percent: 42 }, { version: "1.9.0", kind: "downloading", percent: 42 }],
    [{ status: "downloaded", version: "1.9.0" }, { version: "1.9.0", kind: "downloaded" }],
    [{ status: "available", version: "1.9.0", error: "Download failed. Try again." }, { version: "1.9.0", kind: "failed", detail: "Download failed. Try again." }],
    [{ status: "available", version: "1.9.0", manual: true }, { version: "1.9.0", kind: "manual", detail: expect.stringMatching(/can't update itself/) }],
    [{ status: "available", version: "1.9.0", manual: true, error: "x" }, { version: "1.9.0", kind: "failed", detail: "x" }]
  ] as const)("maps %j", (state, view) => {
    expect(updateRowView(state)).toEqual(view)
  })
})
