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
    render(<Composer branch="jingler/wandering-watt" />)

    expect(screen.getByTitle("Working branch: jingler/wandering-watt")).toBeTruthy()
  })

  it("folds attachments and skills behind one plus button", () => {
    render(
      <Composer skills={[{ name: "/deploy", description: "Deploy the app", source: "skill" }]} />
    )

    expect(screen.queryByLabelText("Attach an image")).toBeNull()
    openMenu()
    expect(screen.getByRole("menuitem", { name: ADD_IMAGE_ITEM })).toBeTruthy()
    expect(screen.getByRole("menuitem", { name: SKILLS_ITEM })).toBeTruthy()
    // MCP now lives ONLY in Settings › Connectors (OpenConnector), never the composer.
    expect(screen.queryByRole("menuitem", { name: MCP_ITEM })).toBeNull()
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
