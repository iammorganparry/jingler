import { describe, expect, it } from "vitest"
import { memoryRecallQuery } from "./memory-recall.js"

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
