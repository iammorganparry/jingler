import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, expect, it, vi } from "vitest"
import { StartFromList, type StartFromListProps } from "./start-from-list.js"

const base: StartFromListProps = {
  kind: "issue", icon: null, label: "Linear issue", search: "", mine: true, pullRequests: [], issues: [],
  selectedPr: null, selectedIssue: null, loading: false, error: null, providerConnected: true, linkedSessions: [],
  onSearch: vi.fn(), onMine: vi.fn(), onRetry: vi.fn(), onPr: vi.fn(), onIssue: vi.fn()
}
afterEach(cleanup)

it("shows Connect when the provider is missing", () => {
  const onConnect = vi.fn()
  render(<StartFromList {...base} providerConnected={false} onConnect={onConnect} />)
  expect(screen.getByText("Linear isn't connected")).toBeTruthy()
  fireEvent.click(screen.getByRole("button", { name: "Connect" }))
  expect(onConnect).toHaveBeenCalled()
})
it("shows empty, error and already-open states", () => {
  const onMine = vi.fn(), onRetry = vi.fn(), onOpenSession = vi.fn()
  const { rerender } = render(<StartFromList {...base} onMine={onMine} />)
  fireEvent.click(screen.getByRole("button", { name: "Search all issues" }))
  expect(onMine).toHaveBeenCalled()
  rerender(<StartFromList {...base} error="x" onRetry={onRetry} />)
  fireEvent.click(screen.getByRole("button", { name: "Retry" }))
  expect(onRetry).toHaveBeenCalled()
  rerender(<StartFromList {...base} linkedSessions={[{ id: "s1", title: "Fix it" }]} onOpenSession={onOpenSession} />)
  expect(screen.getByText("Already open in 'Fix it'")).toBeTruthy()
  fireEvent.click(screen.getByRole("button", { name: "Open it" }))
  expect(onOpenSession).toHaveBeenCalledWith("s1")
  fireEvent.click(screen.getByRole("button", { name: "Create another" }))
  expect(screen.queryByText("Already open in 'Fix it'")).toBeNull()
})
