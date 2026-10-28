import { cleanup, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it } from "vitest"
import { testSession } from "../test-support.js"
import { prStackRowsOf, SessionHoverCard } from "./session-hover-card.js"
import type { PrStackLayer } from "./pr-stack-rail.js"

afterEach(cleanup)

const STACK: ReadonlyArray<PrStackLayer> = [
  { number: 480, branch: "stack/model", state: "merged", checks: "pass" },
  { number: 481, branch: "stack/api", state: "open", checks: "pass" },
  { number: 482, branch: "stack/ui", state: "open", checks: "fail" }
]

describe("prStackRowsOf", () => {
  it("builds one row per layer, bottom of the stack first", () => {
    expect(prStackRowsOf(STACK)).toStrictEqual([
      { number: 480, stateWord: "Merged" },
      { number: 481, stateWord: "Open" },
      { number: 482, stateWord: "Open" }
    ])
  })

  it("gives a layer with no loaded state a placeholder word rather than a guess", () => {
    expect(prStackRowsOf([{ number: 480 }])).toStrictEqual([{ number: 480, stateWord: "—" }])
  })

  it("is empty for an unstacked or absent session", () => {
    expect(prStackRowsOf(undefined)).toStrictEqual([])
    expect(prStackRowsOf([])).toStrictEqual([])
  })
})

describe("SessionHoverCard PR stack", () => {
  it("lists all three PRs in order for a stacked session", () => {
    render(<SessionHoverCard session={testSession({ id: "s1", prNumber: 482 })} stack={STACK} />)
    const list = screen.getByTestId("hover-card-pr-stack")
    expect(screen.getByTestId("hover-card-pr-stack-row-480").textContent).toContain("#480Merged")
    expect(screen.getByTestId("hover-card-pr-stack-row-481").textContent).toContain("#481Open")
    expect(screen.getByTestId("hover-card-pr-stack-row-482").textContent).toContain("#482Open")
    expect(list.children.length).toBe(3)
  })

  it("falls back to the single PR line for an unstacked session", () => {
    render(<SessionHoverCard session={testSession({ id: "s1", prNumber: 482 })} stack={[STACK[2]!]} />)
    expect(screen.queryByTestId("hover-card-pr-stack")).toBeNull()
    expect(screen.getByText("#482")).toBeDefined()
  })

  it("renders no PR line at all for a session with neither a PR nor a stack", () => {
    render(<SessionHoverCard session={testSession({ id: "s1" })} />)
    expect(screen.queryByTestId("hover-card-pr-stack")).toBeNull()
    expect(screen.queryByText(/^#/)).toBeNull()
  })
})
