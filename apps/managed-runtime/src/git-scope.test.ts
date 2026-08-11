import { describe, expect, it } from "vitest"
import { matchesGitRepositoryScope } from "./git-scope.js"

describe("managed Git repository scope", () => {
  it("admits only the hydrated repository", () => {
    expect(matchesGitRepositoryScope("Jingler", "desktop.git", "jingler/desktop")).toBe(true)
    expect(matchesGitRepositoryScope("Jingler", "other.git", "jingler/desktop")).toBe(false)
  })
})
