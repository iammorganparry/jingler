import { describe, expect, it } from "vitest"
import { unstreamedProcessOutput } from "./process-output.js"

describe("managed process output", () => {
  it("returns only output not already delivered by the stream", () => {
    expect(
      unstreamedProcessOutput(
        '{"type":"managed-event"}\n',
        '{"type":"managed-event"}\n{"type":"managed-complete"}\n',
      ),
    ).toBe('{"type":"managed-complete"}\n')
  })

  it("rejects retained logs that are not the streamed output prefix", () => {
    expect(() => unstreamedProcessOutput("second", "first")).toThrow(
      "Managed process output diverged from retained logs",
    )
  })
})
