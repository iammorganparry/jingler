import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { DEFAULT_PLAN_TEMPLATE } from "@jingler/core"
import { afterEach, describe, expect, it, vi } from "vitest"
import { PlanSettings, validatePlanTemplate } from "./plan-settings.js"

afterEach(cleanup)

describe("PlanSettings", () => {
  it("previews and saves a valid custom PRD structure", async () => {
    const onSave = vi.fn()
    render(<PlanSettings source={DEFAULT_PLAN_TEMPLATE} onSave={onSave} />)
    const source = screen.getByLabelText("Plan template source")
    fireEvent.change(source, {
      target: { value: DEFAULT_PLAN_TEMPLATE.replace("## Context", "## Product context") }
    })
    expect(screen.getByText("Product context")).toBeTruthy()
    fireEvent.click(screen.getByRole("button", { name: "Save template" }))
    await waitFor(() => expect(onSave).toHaveBeenCalledOnce())
  })

  it("blocks executable MDX", () => {
    expect(validatePlanTemplate(`import Bad from "./bad"\n${DEFAULT_PLAN_TEMPLATE}`)).toContain(
      "Plan MDX may not contain imports, exports, or JavaScript expressions."
    )
  })

  it("shows the authoritative save failure instead of rejecting silently", async () => {
    const onSave = vi.fn().mockRejectedValue(new Error("Plan template is invalid: duplicate id"))
    render(<PlanSettings source={DEFAULT_PLAN_TEMPLATE} onSave={onSave} />)
    fireEvent.change(screen.getByLabelText("Plan template source"), {
      target: { value: DEFAULT_PLAN_TEMPLATE.replace("## Context", "## Product context") }
    })
    fireEvent.click(screen.getByRole("button", { name: "Save template" }))
    expect(await screen.findByText("Plan template is invalid: duplicate id")).toBeTruthy()
  })

  it("shows synchronous save failures instead of throwing from the click handler", async () => {
    const onSave = vi.fn(() => {
      throw new Error("Plan template transport is unavailable")
    })
    render(<PlanSettings source={DEFAULT_PLAN_TEMPLATE} onSave={onSave} />)
    fireEvent.change(screen.getByLabelText("Plan template source"), {
      target: { value: DEFAULT_PLAN_TEMPLATE.replace("## Context", "## Product context") }
    })
    fireEvent.click(screen.getByRole("button", { name: "Save template" }))
    expect(await screen.findByText("Plan template transport is unavailable")).toBeTruthy()
  })
})
