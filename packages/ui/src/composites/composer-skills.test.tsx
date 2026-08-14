import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it } from "vitest"
import { Composer } from "./composer.js"

const deploy = { name: "/deploy", description: "Ship it", source: "skill" as const }

afterEach(cleanup)

describe("Composer skill menu", () => {
  it("uses the managed skill's canonical invocation after selection", () => {
    render(<Composer skills={[deploy]} />)
    const box = screen.getByRole("textbox")
    fireEvent.change(box, { target: { value: "/" } })
    fireEvent.keyDown(box, { key: "Enter" })
    expect((box as HTMLTextAreaElement).value).toBe("/deploy ")
  })
})
