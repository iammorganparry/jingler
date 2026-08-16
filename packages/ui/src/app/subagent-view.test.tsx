import type { Message } from "@jingler/core"
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest"
import { FleetAgentView } from "./subagent-view.js"

beforeAll(() => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
  )
})
afterEach(cleanup)
afterAll(() => vi.unstubAllGlobals())

describe("FleetAgentView", () => {
  it("renders child tool calls as expandable tool components", () => {
    const message: Message = {
      id: "child-1",
      role: "assistant",
      streaming: false,
      createdAt: "2026-08-16T11:14:28.000Z",
      parts: [{
        _tag: "Tool",
        tool: {
          id: "tool-1",
          name: "command_execute",
          target: "pnpm test",
          status: "success",
          meta: "exit 0",
          diff: null,
          preview: null,
          output: "18 tests passed"
        }
      }]
    }

    render(<FleetAgentView messages={[message]} />)

    expect(screen.getByText("pnpm test")).toBeDefined()
    expect(screen.queryByText(/Tool result \(command_execute\)/)).toBeNull()
    fireEvent.click(screen.getByRole("button", { expanded: false }))
    expect(screen.getByText("18 tests passed")).toBeDefined()
  })
})
