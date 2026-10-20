// @vitest-environment jsdom
import { render, screen } from "@testing-library/react"
import { describe, expect, it } from "vitest"
import { NeedsSignInRow } from "./needs-sign-in-row.js"

describe("NeedsSignInRow", () => {
  it("shows the OAuth host and the deferred sign-in note", () => {
    render(<NeedsSignInRow host="https://linear.example/mcp" />)
    expect(screen.getByText(/Needs sign-in/)).toBeTruthy()
    expect(screen.getByText("https://linear.example/mcp")).toBeTruthy()
    expect(screen.getByText(/Sign in after import/)).toBeTruthy()
  })
})
