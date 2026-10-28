import type { ImportableSession } from "@jingler/core"
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { ImportSessionsList, importSessionKey, type ImportSessionsListProps } from "./import-sessions-list.js"

afterEach(cleanup)

const make = (overrides: Partial<ImportableSession> & { nativeSessionId: string }): ImportableSession => ({
  source: "claude-code",
  harness: "claude",
  cwd: "/dev/jingler",
  title: "Fix sidebar",
  updatedAt: "2026-10-01T10:00:00.000Z",
  messageCount: 3,
  folderExists: true,
  ...overrides
})

const candidates = [
  make({ nativeSessionId: "a" }),
  make({ nativeSessionId: "b", title: "Rate limiting", cwd: "/dev/api", alreadyImported: true }),
  make({ nativeSessionId: "c", source: "codex", harness: "codex", title: "Effect migration" })
]

const setup = (overrides: Partial<ImportSessionsListProps> = {}) => {
  const props: ImportSessionsListProps = {
    candidates,
    status: "ready",
    query: "",
    onQueryChange: vi.fn(),
    selected: new Set(),
    onToggle: vi.fn(),
    onImport: vi.fn(),
    onSkip: vi.fn(),
    onRetry: vi.fn(),
    ...overrides
  }
  render(<ImportSessionsList {...props} />)
  return props
}

describe("ImportSessionsList", () => {
  it("groups by source with counts", () => {
    setup()
    expect(screen.getByRole("region", { name: "Claude Code" }).textContent).toContain("2")
    expect(screen.getByRole("region", { name: "Codex" }).textContent).toContain("1")
  })

  it("filters by title and repo", () => {
    setup({ query: "api" })
    expect(screen.queryByText("Fix sidebar")).toBeNull()
    expect(screen.getByText("Rate limiting")).toBeTruthy()
  })

  it("toggles a row and disables already-imported rows", () => {
    const props = setup()
    fireEvent.click(screen.getByLabelText("Select Fix sidebar"))
    expect(props.onToggle).toHaveBeenCalledWith(importSessionKey(candidates[0]!))
    expect((screen.getByLabelText("Select Rate limiting") as HTMLButtonElement).disabled).toBe(true)
    expect(screen.getByText("Imported")).toBeTruthy()
  })

  it("disables Import at zero and reports the selected count", () => {
    setup()
    expect((screen.getByRole("button", { name: "Import 0 sessions" }) as HTMLButtonElement).disabled).toBe(true)
    cleanup()
    const props = setup({ selected: new Set([importSessionKey(candidates[0]!), importSessionKey(candidates[2]!)]) })
    fireEvent.click(screen.getByRole("button", { name: "Import 2 sessions" }))
    expect(props.onImport).toHaveBeenCalled()
    fireEvent.click(screen.getByRole("button", { name: "Skip" }))
    expect(props.onSkip).toHaveBeenCalled()
  })

  it("shows empty, loading and error states", () => {
    setup({ candidates: [] })
    expect(screen.getByText("No sessions found")).toBeTruthy()
    cleanup()
    const { container } = render(<ImportSessionsList {...{ ...setupProps(), status: "loading" }} />)
    expect(container.querySelector("[aria-busy='true']")).toBeTruthy()
    cleanup()
    const props = setup({ status: "error", error: "boom" })
    fireEvent.click(screen.getByRole("button", { name: "Retry" }))
    expect(props.onRetry).toHaveBeenCalled()
    expect(screen.getByText("boom")).toBeTruthy()
  })
})

function setupProps(): ImportSessionsListProps {
  return {
    candidates,
    status: "ready",
    query: "",
    onQueryChange: vi.fn(),
    selected: new Set(),
    onToggle: vi.fn(),
    onImport: vi.fn(),
    onSkip: vi.fn(),
    onRetry: vi.fn()
  }
}
