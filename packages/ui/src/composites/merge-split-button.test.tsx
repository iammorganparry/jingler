import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { MergeSplitButton } from "./merge-split-button.js"

beforeEach(() => localStorage.clear())
afterEach(cleanup)

describe("MergeSplitButton", () => {
  it("merges with the chosen method and remembers it", () => {
    const onMerge = vi.fn()
    const { unmount } = render(<MergeSplitButton connected onMerge={onMerge} />)
    fireEvent.click(screen.getByRole("button", { name: "Merge method" }))
    fireEvent.click(screen.getByRole("option", { name: "Squash and merge" }))
    fireEvent.click(screen.getByRole("button", { name: "Squash and merge" }))
    expect(onMerge).toHaveBeenCalledWith("squash")
    unmount()
    render(<MergeSplitButton connected onMerge={onMerge} />)
    expect(screen.getByRole("button", { name: "Squash and merge" })).toBeTruthy()
  })

  it("is disabled with the first blocker as its tooltip", () => {
    const onMerge = vi.fn()
    render(<MergeSplitButton connected onMerge={onMerge} blockedReason="Merge conflicts" />)
    expect((screen.getByRole("button", { name: "Merge pull request" }) as HTMLButtonElement).disabled).toBe(true)
    expect(screen.getByTestId("merge-split-button").getAttribute("title")).toBe("Merge conflicts")
  })

  it("shows a failed merge under the button", () => {
    render(<MergeSplitButton connected onMerge={() => {}} mergeError="Base branch was modified" />)
    expect(screen.getByText("Base branch was modified")).toBeTruthy()
  })
})
