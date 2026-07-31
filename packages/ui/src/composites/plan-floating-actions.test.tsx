// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react"
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

  it("gives conflict resolution the primary slot and leaves remote in overflow", () => {
    render(<PlanFloatingActions status="proposed" syncState="conflict" />)
    expect(screen.getByRole("button", { name: "Keep local and save" })).toBeTruthy()
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
