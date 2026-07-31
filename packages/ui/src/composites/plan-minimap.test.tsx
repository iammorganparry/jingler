// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { PlanMinimap } from "./plan-minimap.js"

afterEach(cleanup)

describe("PlanMinimap", () => {
  it("shows structure, execution, comments, viewport, and navigates", () => {
    const onSelect = vi.fn()
    render(
      <PlanMinimap
        items={[
          { id: "title", title: "PRD: Collaboration", kind: "title", openComments: 0 },
          {
            id: "stage:01",
            title: "Build threads",
            kind: "stage",
            executionStatus: "running",
            openComments: 2
          }
        ]}
        activeId="stage:01"
        viewport={{ start: 0.25, size: 0.5 }}
        onSelect={onSelect}
      />
    )

    expect(screen.getByRole("button", { name: /Build threads/ }).getAttribute("aria-current"))
      .toBe("location")
    expect(screen.getByLabelText("2 open comments")).toBeTruthy()
    expect(screen.getByTestId("plan-minimap-viewport").getAttribute("style"))
      .toContain("top: 25%")
    expect(screen.getByRole("list").className).toContain("overflow-y-auto")
    fireEvent.click(screen.getByRole("button", { name: /Build threads/ }))
    expect(onSelect).toHaveBeenCalledWith("stage:01")
  })
})
