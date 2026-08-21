import type { Message } from "@jingler/core"
import { describe, expect, it } from "vitest"
import {
  memoryRecallQuery,
  recentMemoryRecallTurns
} from "./memory-recall.js"

describe("memoryRecallQuery", () => {
  it("adds stable project identity without a checkout path", () => {
    const query = memoryRecallQuery({
      operatorText: "Fix the login retry",
      repo: "acme/widget",
      branch: "feat/login-retry"
    })

    expect(query).toBe(
      "Fix the login retry\nProject: acme/widget\nBranch: feat/login-retry"
    )
    expect(query).not.toContain("/Users/")
  })

  it("includes only the last three visible conversation turns", () => {
    const query = memoryRecallQuery({
      operatorText: "Continue the retry fix",
      repo: "acme/widget",
      branch: "main",
      recentTurns: [
        { role: "user", text: "oldest omitted" },
        { role: "assistant", text: "Found the shared helper" },
        { role: "user", text: "Use bounded jitter" },
        { role: "assistant", text: "Updated the retry loop" }
      ]
    })

    expect(query).not.toContain("oldest omitted")
    expect(query).toContain("assistant: Found the shared helper")
    expect(query).toContain("user: Use bounded jitter")
    expect(query).toContain("assistant: Updated the retry loop")
  })

  it("extracts only text parts from canonical transcript messages", () => {
    const messages: Message[] = [{
      id: "assistant-1",
      role: "assistant",
      streaming: false,
      createdAt: "2026-08-20T09:00:00.000Z",
      parts: [
        { _tag: "Text", text: "Visible outcome" },
        { _tag: "Thinking", text: "private reasoning", seconds: 1, streaming: false }
      ]
    }]

    expect(recentMemoryRecallTurns(messages)).toEqual([
      { role: "assistant", text: "Visible outcome" }
    ])
  })

  it.each(["/review now", "$deploy production"])(
    "skips automatic recall for command-led input: %s",
    (operatorText) => {
      expect(memoryRecallQuery({
        operatorText,
        repo: "acme/widget",
        branch: "main"
      })).toBeUndefined()
    }
  )
})
