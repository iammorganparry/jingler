import "@testing-library/jest-dom/vitest"
import { cleanup, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it } from "vitest"
import { Badge } from "./badge.js"
import { CodeChip } from "./code-chip.js"
import { FileChip } from "./file-chip.js"
import { Kbd } from "./kbd.js"
import { Pill } from "./pill.js"

afterEach(cleanup)

describe("one-line atoms", () => {
  it("Badge never wraps or shrinks", () => {
    render(<Badge>Subscription</Badge>)
    expect(screen.getByText("Subscription").closest("span.rounded-full")).toHaveClass("shrink-0", "whitespace-nowrap")
  })

  it("Pill never wraps or shrinks", () => {
    render(<Pill>Connected</Pill>)
    expect(screen.getByText("Connected")).toHaveClass("shrink-0", "whitespace-nowrap")
  })

  it("Kbd never wraps or shrinks", () => {
    render(<Kbd>⌘K</Kbd>)
    expect(screen.getByText("⌘K")).toHaveClass("shrink-0", "whitespace-nowrap")
  })

  it("CodeChip truncates its label and keeps the line number and remove button", () => {
    render(<CodeChip path="src/a.ts" line={4} onRemove={() => {}} />)
    expect(screen.getByText("a.ts")).toHaveClass("truncate", "min-w-0")
    expect(screen.getByText(":4")).toHaveClass("shrink-0")
    expect(screen.getByRole("button", { name: "Remove a.ts" })).toHaveClass("shrink-0")
    expect(screen.getByTitle("src/a.ts")).toHaveClass("whitespace-nowrap", "max-w-full")
  })

  it("FileChip stays on one line and truncates the path", () => {
    render(<FileChip path="src/auth/token-store.ts" />)
    expect(screen.getByText("src/auth/token-store.ts").parentElement).toHaveClass("whitespace-nowrap")
    expect(screen.getByText("src/auth/token-store.ts")).toHaveClass("truncate")
  })
})
