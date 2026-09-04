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
      ? [{ name: "linear", source, target: "npx linear", problem: null }]
      : source === "codex"
        ? [
            { name: "linear", source, target: "duplicate", problem: null },
            { name: "docs", source, target: "https://docs.example/mcp", problem: null }
          ]
        : [{ name: "broken", source, target: "", problem: "invalid" }]
    )
    const apply = vi.fn(async () => [])

    render(<McpImportPrompt ready servers={[]} load={load} apply={apply} />)

    expect(await screen.findByRole("dialog")).toBeTruthy()
    expect(screen.getByText("linear")).toBeTruthy()
    expect(screen.getByText("docs")).toBeTruthy()
    expect(screen.queryByText("broken")).toBeNull()
    fireEvent.click(screen.getByText("Import all"))
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull())
    expect(apply.mock.calls).toEqual([
      ["claude", ["linear"]],
      ["codex", ["docs"]]
    ])
  })

  it("does not prompt for servers already configured", async () => {
    render(<McpImportPrompt
      ready
      servers={[{
        name: "linear",
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
        problem: null
      }]}
      apply={async () => []}
    />)

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull())
  })
})
