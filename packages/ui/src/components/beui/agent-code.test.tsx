import { renderHook, waitFor } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"

const loadLanguage = vi.fn(async () => { throw new Error("grammar import failed") })
const codeToTokensWithThemes = vi.fn(() => { throw new Error("must not tokenize an unloaded grammar") })

vi.mock("shiki", () => ({
  bundledLanguages: { python: () => Promise.resolve({}) },
  createHighlighter: async () => ({ getLoadedLanguages: () => [], loadLanguage, codeToTokensWithThemes }),
}))

import { useAgentCodeTokens } from "./agent-code.js"

describe("useAgentCodeTokens", () => {
  it("keeps plain text when a lazy grammar fails to load", async () => {
    const unhandled = vi.fn()
    process.on("unhandledRejection", unhandled)
    const { result } = renderHook(() => useAgentCodeTokens("print(1)", "python"))
    await waitFor(() => expect(loadLanguage).toHaveBeenCalledWith("python"))
    await new Promise((resolve) => setTimeout(resolve, 20))
    process.off("unhandledRejection", unhandled)

    expect(result.current).toBeNull()
    expect(codeToTokensWithThemes).not.toHaveBeenCalled()
    expect(unhandled).not.toHaveBeenCalled()
  })
})
