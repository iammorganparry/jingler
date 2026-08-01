import "@testing-library/jest-dom/vitest"
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { FileChip } from "./file-chip.js"

afterEach(cleanup)

describe("FileChip", () => {
  it("uses a Material file icon and opens the full path", () => {
    const onOpen = vi.fn()
    render(
      <FileChip path="src/auth/token-store.ts" added={8} removed={3} onOpen={onOpen} />
    )

    const chip = screen.getByRole("button", {
      name: "Open src/auth/token-store.ts (+8 −3)"
    })
    expect(chip).toHaveTextContent("src/auth/token-store.ts")
    expect(chip).toHaveTextContent("+8")
    expect(chip).toHaveTextContent("−3")
    expect(chip).toHaveClass("inline-flex", "min-h-8", "max-w-full")
    expect(screen.getByText("src/auth/token-store.ts")).toHaveClass("text-center")
    expect(chip.querySelector("[data-material-file-icon='typescript']")).not.toBeNull()

    fireEvent.click(chip)
    expect(onOpen).toHaveBeenCalledWith("src/auth/token-store.ts")
  })

  it("renders unchanged evidence without empty diff counters", () => {
    render(<FileChip path="README.md" />)

    expect(screen.getByText("README.md")).toBeVisible()
    expect(screen.queryByText(/^\+/)).toBeNull()
  })
})
