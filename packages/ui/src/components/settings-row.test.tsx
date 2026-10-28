import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { SettingsCard, SettingsRow } from "./settings-row.js"
import { Toggle } from "./toggle.js"

afterEach(cleanup)

describe("SettingsRow", () => {
  it("lets the help text wrap while the control stays fixed", () => {
    render(<SettingsRow label="ADHD mode" help={"Long help ".repeat(40)} control={<Toggle aria-label="ADHD mode" />} />)
    expect(screen.getByTestId("settings-row-control").className).toContain("flex-none")
    expect(screen.getByText("ADHD mode").parentElement?.className).toContain("min-w-0")
  })

  it("renders a titled card of rows", () => {
    render(<SettingsCard title="General"><SettingsRow label="A" control={null} /><SettingsRow label="B" control={null} /></SettingsCard>)
    expect(screen.getByRole("heading", { name: "General" })).toBeTruthy()
    expect(screen.getAllByTestId("settings-row")).toHaveLength(2)
  })
})

describe("Toggle", () => {
  it("is a switch that toggles on Space/click with a neutral checked track", () => {
    const onChange = vi.fn()
    render(<Toggle aria-label="Offload" onCheckedChange={onChange} />)
    const toggle = screen.getByRole("switch", { name: "Offload" })
    // Native buttons turn Space into a click; jsdom doesn't, so assert the click path.
    fireEvent.click(toggle)
    expect(onChange).toHaveBeenCalledWith(true)
    expect(toggle.getAttribute("aria-checked")).toBe("true")
    expect(toggle.className).toContain("bg-primary-fill")
    expect(toggle.className).not.toContain("bg-brand")
    expect(toggle.tagName).toBe("BUTTON")
  })
})
