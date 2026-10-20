// @vitest-environment jsdom
import { render, screen } from "@testing-library/react"
import { describe, expect, it } from "vitest"
import { NeedsSecretsRow } from "./needs-secrets-row.js"

describe("NeedsSecretsRow", () => {
  it("shows the missing-secret note", () => {
    render(<NeedsSecretsRow />)
    expect(screen.getByText(/Needs a secret value/)).toBeTruthy()
    expect(screen.getByText(/Add it in Settings after import/)).toBeTruthy()
  })
})
