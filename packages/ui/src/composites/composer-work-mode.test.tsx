import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { Composer } from "./composer.js"

afterEach(cleanup)

describe("Composer work mode toggle", () => {
  it("choosing Plan calls the work-mode handler and leaves the approval value untouched", () => {
    const onSetWorkMode = vi.fn()
    const onSetMode = vi.fn()
    render(<Composer mode="auto" onSetMode={onSetMode} workMode="build" onSetWorkMode={onSetWorkMode} />)
    fireEvent.click(screen.getByRole("tab", { name: "Plan" }))
    expect(onSetWorkMode).toHaveBeenCalledWith("plan")
    expect(onSetMode).not.toHaveBeenCalled()
    expect(screen.getByRole("button", { name: "Auto", exact: false })).toBeDefined()
  })
})
