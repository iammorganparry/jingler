import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { Composer } from "./composer.js"

afterEach(cleanup)

const ADD_IMAGE_ITEM = /Add image/
const SKILLS_ITEM = /Skills/
const MCP_ITEM = /MCP connectors/

const openMenu = () =>
  fireEvent.pointerDown(screen.getByRole("button", { name: "Composer menu" }), {
    button: 0,
    ctrlKey: false
  })

describe("Composer tools menu", () => {
  it("shows the session branch in the toolbar", () => {
    render(<Composer branch="starbase/wandering-watt" />)

    expect(screen.getByTitle("Working branch: starbase/wandering-watt")).toBeTruthy()
  })

  it("folds attachments, skills, and MCP connectors behind one plus button", () => {
    render(
      <Composer
        skills={[{ name: "/deploy", description: "Deploy the app", source: "skill" }]}
        mcp={{ total: 3, failed: 0, probed: true }}
        onOpenMcp={() => {}}
      />
    )

    expect(screen.queryByLabelText("Attach an image")).toBeNull()
    openMenu()
    expect(screen.getByRole("menuitem", { name: ADD_IMAGE_ITEM })).toBeTruthy()
    expect(screen.getByRole("menuitem", { name: SKILLS_ITEM })).toBeTruthy()
    expect(screen.getByRole("menuitem", { name: MCP_ITEM })).toBeTruthy()
  })

  it("opens MCP connectors from the menu", () => {
    const onOpenMcp = vi.fn()
    render(
      <Composer
        mcp={{ total: 2, failed: 1, probed: true }}
        onOpenMcp={onOpenMcp}
      />
    )

    openMenu()
    fireEvent.click(screen.getByRole("menuitem", { name: MCP_ITEM }))
    expect(onOpenMcp).toHaveBeenCalledOnce()
  })

  it("opens the existing skill palette from the menu", () => {
    render(
      <Composer skills={[{ name: "/deploy", description: "Deploy the app", source: "skill" }]} />
    )

    openMenu()
    fireEvent.click(screen.getByRole("menuitem", { name: SKILLS_ITEM }))
    expect(screen.getByText("/deploy")).toBeTruthy()
  })
})
