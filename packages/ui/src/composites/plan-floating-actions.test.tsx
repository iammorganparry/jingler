// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react"
import { afterEach, describe, expect, it } from "vitest"
import type { PlanDocumentStatus } from "@jingler/core"
import { PlanFloatingActions } from "./plan-floating-actions.js"

afterEach(cleanup)

describe("PlanFloatingActions", () => {
  const expected: ReadonlyArray<[PlanDocumentStatus, string]> = [
    ["draft", "Send to agent"],
    ["proposed", "Approve"],
    ["stale", "Approve & implement"],
    ["executing", "Implementation running"],
    ["done", "Plan completed"]
  ]

  for (const [status, label] of expected) {
    it(`uses the ${label} primary action for ${status}`, () => {
      render(<PlanFloatingActions status={status} syncState="clean" />)
      expect(screen.getByRole("button", { name: label })).toBeTruthy()
    })
  }

  it("offers the extra approval options behind the split-button dropdown", () => {
    render(<PlanFloatingActions status="proposed" syncState="clean" />)
    expect(screen.getByRole("button", { name: "Approve" })).toBeTruthy()
    expect(screen.getByRole("button", { name: "More plan actions" })).toBeTruthy()
  })

  it("makes an in-flight draft visibly composing and non-actionable", () => {
    render(
      <PlanFloatingActions
        transientState="composing"
        syncState="clean"
      />
    )
    expect(
      screen.getByRole("button", { name: "Composing plan" }).hasAttribute("disabled")
    ).toBe(true)
    expect(screen.getByTestId("plan-status-summary").textContent).toContain("composing")
  })

  it("shows the plan status and actions without a sync/revision indicator", () => {
    render(
      <PlanFloatingActions status="proposed" revision={7} syncState="clean" />
    )

    const dock = screen.getByTestId("plan-floating-actions")
    expect(dock.contains(screen.getByTestId("plan-status-summary"))).toBe(true)
    expect(dock.textContent).toContain("proposed")
    // The plan is agent-controlled and read-only: no sync state, no revision.
    expect(dock.textContent).not.toContain("revision 7")
    expect(dock.textContent).not.toContain("Synced")
    expect(within(dock).getByRole("button", { name: "Approve" })).toBeTruthy()
  })

  for (const [transientState, label] of [
    ["validating", "Validating plan"],
    ["promoting", "Loading revision"]
  ] as const) {
    it(`labels ${transientState} with its actual phase`, () => {
      render(
        <PlanFloatingActions
          transientState={transientState}
          syncState="clean"
        />
      )
      expect(screen.getByRole("button", { name: label })).toBeTruthy()
    })
  }
})
