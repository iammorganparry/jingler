import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { PlanSettings, validatePlanTemplate } from "./plan-settings.js"

afterEach(cleanup)

const plan = JSON.stringify({
  title: "Plan",
  sections: [{ id: "tldr", title: "TL;DR", blocks: [] }],
  stages: [],
  annotations: []
})

describe("PlanSettings", () => {
  it("validates and saves the single-agent enhanced plan template", () => {
    const onSave = vi.fn()
    render(<PlanSettings source={plan} onSave={onSave} />)
    expect(screen.getByText(/selected agent owns progress/i)).toBeTruthy()
    fireEvent.change(screen.getByLabelText("Plan template source"), {
      target: { value: plan.replace('"Plan"', '"Updated"') }
    })
    fireEvent.click(screen.getByRole("button", { name: /Save template/ }))
    expect(onSave).toHaveBeenCalled()
  })

  it("rejects invalid structured plan JSON", () => {
    expect(validatePlanTemplate("not json")).toStrictEqual(["The plan template is not valid JSON."])
  })
})
