import { describe, expect, it } from "vitest"
import {
  memoryRetentionContent,
  memoryRetentionIdentity,
  type MemoryRetentionInput
} from "./memory-retain.js"

const input: MemoryRetentionInput = {
  sessionId: "session-1",
  chatId: "chat-1",
  turnId: "assistant-1",
  repository: "widget",
  userText: "Update the retry policy",
  assistantText: "Reused the shared backoff helper.",
  settledAt: "2026-08-20T09:00:00.000Z"
}

describe("memory retention", () => {
  it("derives identity only from the stable conversation turn boundary", () => {
    expect(memoryRetentionIdentity(input)).toBe(
      "session-1\u0000chat-1\u0000assistant-1"
    )
    expect(memoryRetentionIdentity({
      ...input,
      turnId: "assistant-2"
    })).not.toBe(memoryRetentionIdentity(input))
  })

  it("renders only typed visible provenance through the supplied sanitizer", () => {
    const content = memoryRetentionContent(input, (value) =>
      value.replace("retry", "[SANITIZED]")
    )

    expect(content).toContain("Repository: widget")
    expect(content).toContain("User input:\nUpdate the [SANITIZED] policy")
    expect(content).toContain("Assistant outcome:\nReused the shared backoff helper.")
    expect(content).not.toContain("tool")
    expect(content).not.toContain("prompt")
    expect(content).not.toContain("memory")
  })

  it("bounds retained user and assistant text", () => {
    const content = memoryRetentionContent({
      ...input,
      userText: "u".repeat(4_000),
      assistantText: "a".repeat(5_000)
    }, (value) => value)

    expect(content.length).toBeLessThanOrEqual(8_000)
    expect(content.match(/\[TRUNCATED\]/gu)).toHaveLength(2)
  })
})
