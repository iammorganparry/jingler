import { cleanup, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it } from "vitest"
import { Button, buttonVariants } from "./button.js"

afterEach(cleanup)

describe("Button variants (spec §6.10)", () => {
  it("primary uses the neutral primary tokens, never brand or red", () => {
    const cls = buttonVariants({ variant: "primary" })
    expect(cls).toContain("bg-primary-fill")
    expect(cls).toContain("text-primary-fg")
    expect(cls).toContain("hover:bg-primary-hover")
    expect(cls).toContain("disabled:bg-primary-disabled")
    expect(cls).not.toMatch(/bg-brand|bg-red|bg-state-failed/)
  })

  it("is the default variant and shows the disabled token when disabled", () => {
    render(<Button disabled>Save</Button>)
    const button = screen.getByRole("button", { name: "Save" })
    expect(button.className).toContain("bg-primary-fill")
    expect(button.className).toContain("disabled:bg-primary-disabled")
    expect((button as HTMLButtonElement).disabled).toBe(true)
  })

  it("secondary is transparent with a strong border", () => {
    const cls = buttonVariants({ variant: "secondary" })
    expect(cls).toContain("bg-transparent")
    expect(cls).toContain("border-line-strong")
  })

  it("danger is failed-coloured text on transparent, not a fill", () => {
    const cls = buttonVariants({ variant: "danger" })
    expect(cls).toContain("text-state-failed")
    expect(cls).toContain("bg-transparent")
    expect(cls).not.toMatch(/(^|\s)bg-state-failed/)
  })

  it("only destructive-solid fills with the failed colour", () => {
    expect(buttonVariants({ variant: "destructive-solid" })).toMatch(/(^|\s)bg-state-failed/)
    for (const v of ["primary", "secondary", "danger", "ghost", "outline"] as const) {
      expect(buttonVariants({ variant: v })).not.toMatch(/(^|\s)bg-(brand|red)(\s|$|\/)/)
    }
  })
})
