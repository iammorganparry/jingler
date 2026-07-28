import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { DEFAULT_PLAN_TEMPLATE } from "@jingler/core"
import { afterEach, describe, expect, it, vi } from "vitest"
import { PlanSettings, validatePlanTemplate } from "./plan-settings.js"

afterEach(cleanup)

describe("PlanSettings", () => {
  it("previews and saves a valid custom PRD structure", () => {
    const onSave = vi.fn()
    render(<PlanSettings source={DEFAULT_PLAN_TEMPLATE} onSave={onSave} />)
    const source = screen.getByLabelText("Plan template source")
    fireEvent.change(source, {
      target: { value: DEFAULT_PLAN_TEMPLATE.replace("## Context", "## Product context") }
    })
    expect(screen.getByText("Product context")).toBeTruthy()
    fireEvent.click(screen.getByRole("button", { name: "Save template" }))
    expect(onSave).toHaveBeenCalledOnce()
  })

  it("blocks executable MDX", () => {
    expect(validatePlanTemplate(`import Bad from "./bad"\n${DEFAULT_PLAN_TEMPLATE}`)).toContain(
      "Imports, exports, and JavaScript expressions are not allowed."
    )
  })
})
