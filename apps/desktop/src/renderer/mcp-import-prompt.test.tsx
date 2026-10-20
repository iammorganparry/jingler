// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { McpImportPrompt } from "./mcp-import-prompt.js"

afterEach(() => {
  cleanup()
  localStorage.clear()
})

describe("McpImportPrompt", () => {
  it("discovers all sources, dedupes names, and imports by source once", async () => {
    const load = vi.fn(async (source: "claude" | "codex" | "opencode") => source === "claude"
      ? [{ name: "linear", source, target: "npx linear", problem: null, needsSignIn: false }]
      : source === "codex"
        ? [
            { name: "linear", source, target: "duplicate", problem: null, needsSignIn: false },
            { name: "docs", source, target: "https://docs.example/mcp", problem: null, needsSignIn: true }
          ]
        : [{ name: "broken", source, target: "", problem: "invalid", needsSignIn: false }]
    )
    const apply = vi.fn(async () => [])

    render(<McpImportPrompt ready servers={[]} load={load} apply={apply} />)

    expect(await screen.findByRole("dialog")).toBeTruthy()
    expect(screen.getByText("linear")).toBeTruthy()
    expect(screen.getByText("docs")).toBeTruthy()
    expect(screen.queryByText("broken")).toBeNull()
    // Acceptance: an OAuth server imports marked "Needs sign-in".
    expect(screen.getByText(/Needs sign-in/)).toBeTruthy()
    fireEvent.click(screen.getByText("Import 2 servers"))
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull())
    expect(apply.mock.calls).toEqual([
      ["claude", ["linear"]],
      ["codex", ["docs"]]
    ])
  })

  it("flags a candidate that clashes with an already-configured server", async () => {
    render(<McpImportPrompt
      ready
      servers={[{
        name: "linear",
        displayName: "linear",
        iconUrl: null,
        authKind: "none",
        authState: "not-required",
        transport: "http",
        scope: "user",
        target: "https://linear.example/mcp",
        envKeys: [],
        headerKeys: [],
        enabled: true
      }]}
      load={async (source) => [{
        name: "linear",
        source,
        target: "https://linear.example/mcp",
        problem: null,
        needsSignIn: false
      }]}
      apply={async () => []}
    />)

    expect(await screen.findByRole("dialog")).toBeTruthy()
    expect(screen.getByText("Conflict")).toBeTruthy()
  })
})
