import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it } from "vitest"
import { Composer } from "./composer.js"

const deploy = { name: "/deploy", description: "Ship it", source: "skill" as const }
const ponytail = {
  name: "/ponytail",
  description: "Set minimal-code mode.",
  source: "command" as const
}
const explain = {
  name: "/explain",
  description: "Publish a focused visual explanation.",
  source: "skill" as const
}

afterEach(cleanup)

describe("Composer skill menu", () => {
  it("uses the managed skill's canonical invocation after selection", () => {
    render(<Composer skills={[deploy]} />)
    const box = screen.getByRole("textbox")
    fireEvent.change(box, { target: { value: "/" } })
    fireEvent.keyDown(box, { key: "Enter" })
    expect((box as HTMLTextAreaElement).value).toBe("/deploy ")
  })

  it("offers Ponytail as a first-class mode command", () => {
    render(<Composer skills={[ponytail]} />)
    const box = screen.getByRole("textbox")
    fireEvent.change(box, { target: { value: "/" } })
    expect(screen.getByText("/ponytail")).toBeTruthy()
    fireEvent.keyDown(box, { key: "Enter" })
    expect((box as HTMLTextAreaElement).value).toBe("/ponytail ")
  })

  it("offers the built-in explain hard trigger", () => {
    render(<Composer skills={[explain]} />)
    const box = screen.getByRole("textbox")
    fireEvent.change(box, { target: { value: "/" } })
    expect(screen.getByText("/explain")).toBeTruthy()
    fireEvent.keyDown(box, { key: "Enter" })
    expect((box as HTMLTextAreaElement).value).toBe("/explain ")
  })
})
