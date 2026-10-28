import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { CrashScreen } from "./crash-screen.js"

afterEach(cleanup)

describe("CrashScreen", () => {
  it("shows the three actions and fires reload and open-logs", () => {
    const onReload = vi.fn()
    const onOpenLogs = vi.fn()
    render(<CrashScreen details="Error: boom" onReload={onReload} onOpenLogs={onOpenLogs} />)
    expect(screen.getByRole("heading", { name: "Jingler hit an error" })).toBeTruthy()
    fireEvent.click(screen.getByRole("button", { name: "Reload window" }))
    fireEvent.click(screen.getByRole("button", { name: "Open logs" }))
    expect(onReload).toHaveBeenCalledOnce()
    expect(onOpenLogs).toHaveBeenCalledOnce()
    expect(screen.getByRole("button", { name: "Copy error details" })).toBeTruthy()
  })

  it("copies the details", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.assign(navigator, { clipboard: { writeText } })
    render(<CrashScreen details="Error: boom" onReload={() => {}} />)
    fireEvent.click(screen.getByRole("button", { name: "Copy error details" }))
    expect(writeText).toHaveBeenCalledWith("Error: boom")
    await waitFor(() => expect(screen.getByRole("button", { name: "Copied" })).toBeTruthy())
  })

  it("omits Open logs when no handler is given and keeps primary neutral", () => {
    render(<CrashScreen details="x" onReload={() => {}} />)
    expect(screen.queryByRole("button", { name: "Open logs" })).toBeNull()
    expect(screen.getByRole("button", { name: "Reload window" }).className).toContain("bg-primary-fill")
  })
})
