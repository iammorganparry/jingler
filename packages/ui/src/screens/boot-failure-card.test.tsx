import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { BootFailureCard } from "./boot-failure-card.js"

afterEach(cleanup)

describe("BootFailureCard", () => {
  it("shows the title and fires Retry", () => {
    const onRetry = vi.fn()
    render(<BootFailureCard error="boom" onRetry={onRetry} getDiagnostics={() => Promise.resolve("")} />)
    expect(screen.getByRole("heading", { name: "Jingler couldn't start" })).toBeTruthy()
    fireEvent.click(screen.getByRole("button", { name: "Retry" }))
    expect(onRetry).toHaveBeenCalledOnce()
  })

  it("copies diagnostics to the clipboard", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.assign(navigator, { clipboard: { writeText } })
    const getDiagnostics = vi.fn().mockResolvedValue("diag-json")
    render(<BootFailureCard error="boom" onRetry={() => {}} getDiagnostics={getDiagnostics} />)
    fireEvent.click(screen.getByRole("button", { name: "Copy diagnostics" }))
    expect(getDiagnostics).toHaveBeenCalledOnce()
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("diag-json"))
    await waitFor(() => expect(screen.getByRole("button", { name: "Copied" })).toBeTruthy())
  })

  it("reveals the raw error in a details disclosure", () => {
    const { container } = render(<BootFailureCard error="ECONNREFUSED" onRetry={() => {}} getDiagnostics={() => Promise.resolve("")} />)
    const details = container.querySelector("details")!
    expect(details.open).toBe(false)
    fireEvent.click(screen.getByText("Details"))
    details.open = true
    expect(screen.getByText("ECONNREFUSED").tagName).toBe("PRE")
    expect(screen.getByText("ECONNREFUSED").className).toContain("font-mono")
  })
})
