import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { Composer } from "../composites/composer.js"
import { CodeChip } from "./code-chip.js"

const SEND_BUTTON = /Send/

afterEach(cleanup)

describe("CodeChip", () => {
  it("keeps line-only timeline references as basename plus a dim line number", () => {
    render(<CodeChip path="packages/ui/src/parser [new].ts" line={12} />)

    expect(screen.getByText("parser [new].ts")).toBeDefined()
    expect(screen.getByText(":12").className).toContain("text-dim")
    expect(screen.queryByText("packages/ui/src/parser [new].ts:L12")).toBeNull()
    expect(screen.getByTitle("packages/ui/src/parser [new].ts")).toBeDefined()
  })

  it("shows a repository path for a captured single-line range", () => {
    render(
      <CodeChip
        path="src/parser [new].ts"
        line={12}
        endLine={12}
        label="src/parser [new].ts:L12"
      />
    )

    expect(screen.getByText("src/parser [new].ts:L12")).toBeDefined()
  })

  it("shows both ends of an inclusive range and removes only that reference", () => {
    const onRemove = vi.fn()
    render(
      <CodeChip
        path="src/parser.ts"
        line={12}
        endLine={15}
        label={"src/parser.ts:L12\u2013L15"}
        onRemove={onRemove}
      />
    )

    fireEvent.click(screen.getByRole("button", { name: "Remove src/parser.ts:L12\u2013L15" }))
    expect(onRemove).toHaveBeenCalledOnce()
  })

  it("renders captured range order as provided instead of normalizing it", () => {
    render(<CodeChip path="src/parser.ts" line={15} endLine={12} />)

    expect(screen.getByText("src/parser.ts:L15\u2013L12")).toBeDefined()
  })

  it("keeps bare @file mentions compact", () => {
    render(<CodeChip path="packages/ui/src/index.ts" />)
    expect(screen.getByText("index.ts")).toBeDefined()
    expect(screen.queryByText("packages/ui/src/index.ts")).toBeNull()
  })
})

describe("Composer code references", () => {
  it("sends a reference-only draft and clears its structured context", () => {
    const onSend = vi.fn()
    const onClear = vi.fn()
    render(
      <Composer
        onSend={onSend}
        codeReferences={[
          {
            path: "src/parser.ts",
            startLine: 12,
            endLine: 15,
            label: "src/parser.ts:L12\u2013L15"
          }
        ]}
        onCodeReferencesClear={onClear}
      />
    )

    fireEvent.click(screen.getByRole("button", { name: SEND_BUTTON }))
    expect(onSend).toHaveBeenCalledWith("", [])
    expect(onClear).toHaveBeenCalledOnce()
  })

  it("removes a range without changing the visible message", () => {
    const onRemove = vi.fn()
    const onValueChange = vi.fn()
    render(
      <Composer
        value="Keep this message"
        onValueChange={onValueChange}
        codeReferences={[
          {
            path: "src/parser.ts",
            startLine: 12,
            endLine: 15,
            label: "src/parser.ts:L12\u2013L15"
          }
        ]}
        onCodeReferenceRemove={onRemove}
      />
    )

    fireEvent.click(screen.getByRole("button", { name: "Remove src/parser.ts:L12\u2013L15" }))
    expect(onRemove).toHaveBeenCalledWith(0)
    expect(onValueChange).not.toHaveBeenCalled()
    expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe("Keep this message")
  })
})
