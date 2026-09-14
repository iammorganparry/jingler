import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { Composer } from "./composer.js"

afterEach(cleanup)

const ADD_IMAGE_ITEM = /Add image/
const SKILLS_ITEM = /Skills/
const MCP_ITEM = /Connect MCP server/

const openMenu = () => fireEvent.click(screen.getByRole("button", { name: "Composer menu" }))

describe("Composer tools menu", () => {
  it("shows the session branch in the toolbar", () => {
    render(<Composer branch="chore/wandering-watt" />)

    expect(screen.getByTitle("Working branch: chore/wandering-watt")).toBeTruthy()
  })

  it("folds attachments and skills behind one plus button", () => {
    render(<Composer skills={[{ name: "/deploy", description: "Deploy the app", source: "skill" }]} />)

    expect(screen.queryByLabelText("Attach an image")).toBeNull()
    openMenu()
    expect(screen.getByRole("button", { name: ADD_IMAGE_ITEM })).toBeTruthy()
    expect(screen.getByRole("button", { name: SKILLS_ITEM })).toBeTruthy()
    expect(screen.queryByRole("button", { name: MCP_ITEM })).toBeNull()
  })

  it("opens the global MCP server dialog when configured", () => {
    render(<Composer onAddMcp={async () => {}} />)

    openMenu()
    fireEvent.click(screen.getByRole("button", { name: MCP_ITEM }))
    expect(screen.getByRole("dialog")).toBeTruthy()
    expect(screen.getByText("Saves to ~/jingler/mcp.json and becomes available to local sessions on their next turn.")).toBeTruthy()
  })

  it("lists configured MCP connections and starts their auth action", () => {
    const authorize = vi.fn(async () => {})
    render(<Composer
      onAddMcp={async () => {}}
      onAuthorizeMcp={authorize}
      mcpServers={[{
        name: "linear",
        displayName: "Linear",
        iconUrl: null,
        authKind: "oauth",
        authState: "needs-auth",
        transport: "http",
        scope: "user",
        target: "https://mcp.linear.app/mcp",
        envKeys: [],
        headerKeys: [],
        enabled: true
      }]}
    />)

    openMenu()
    fireEvent.click(screen.getByRole("button", { name: /Linear/ }))
    expect(authorize).toHaveBeenCalledWith("linear")
  })

  it("opens the existing skill palette from the menu", () => {
    render(<Composer skills={[{ name: "/deploy", description: "Deploy the app", source: "skill" }]} />)

    openMenu()
    fireEvent.click(screen.getByRole("button", { name: SKILLS_ITEM }))
    expect(screen.getByText("/deploy")).toBeTruthy()
  })
})
