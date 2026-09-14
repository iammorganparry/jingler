import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { Composer } from "./composer.js"

const scrollIntoView = vi.fn()
Object.defineProperty(Element.prototype, "scrollIntoView", { configurable: true, value: scrollIntoView })

afterEach(() => {
  cleanup()
  scrollIntoView.mockClear()
})

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
    expect(screen.getByRole("option", { name: ADD_IMAGE_ITEM })).toBeTruthy()
    expect(screen.getByRole("option", { name: SKILLS_ITEM })).toBeTruthy()
    expect(screen.queryByRole("option", { name: MCP_ITEM })).toBeNull()
  })

  it("opens the global MCP server dialog when configured", () => {
    render(<Composer onAddMcp={async () => {}} />)

    openMenu()
    fireEvent.click(screen.getByRole("option", { name: MCP_ITEM }))
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
    fireEvent.click(screen.getByRole("option", { name: /Linear/ }))
    expect(authorize).toHaveBeenCalledWith("linear")
  })

  it("searches servers and opens auth setup for unconfigured HTTP entries", async () => {
    const setAuth = vi.fn(async () => {})
    const servers = ["Linear", "Sentry", "PostHog", "Figma", "Supabase"].map((displayName) => ({
      name: displayName.toLocaleLowerCase(),
      displayName,
      iconUrl: null,
      authKind: "none" as const,
      authState: "not-required" as const,
      transport: "http" as const,
      scope: "user" as const,
      target: `https://mcp.${displayName.toLocaleLowerCase()}.com/mcp`,
      envKeys: [],
      headerKeys: [],
      enabled: true
    }))
    render(<Composer
      initialValue="draft "
      onAddMcp={async () => {}}
      onSetMcpAuth={setAuth}
      onSetMcpApiKey={async () => {}}
      onAuthorizeMcp={async () => {}}
      mcpServers={servers}
    />)

    const composer = screen.getByPlaceholderText("Message the agent…")
    openMenu()
    expect(screen.getByPlaceholderText("Search actions…").getAttribute("aria-controls")).toBeTruthy()
    fireEvent.keyDown(composer, { key: "ArrowDown" })
    await waitFor(() => expect(scrollIntoView).toHaveBeenCalled())
    expect((screen.getByRole("button", { name: "Send ↵" }) as HTMLButtonElement).disabled).toBe(true)
    fireEvent.change(composer, { target: { value: "draft" } })
    expect((composer as HTMLTextAreaElement).value).toBe("draft ")
    scrollIntoView.mockClear()
    fireEvent.change(composer, { target: { value: "draft fig" } })
    await waitFor(() => expect(scrollIntoView).toHaveBeenCalled())
    expect(screen.queryByText("Linear")).toBeNull()
    const figma = screen.getByRole("option", { name: /Figma/ })
    expect(figma.getAttribute("aria-selected")).toBe("true")
    expect(composer.getAttribute("aria-activedescendant")).toBe(figma.id)
    fireEvent.keyDown(composer, { key: "Enter" })
    expect((composer as HTMLTextAreaElement).value).toBe("draft ")
    fireEvent.click(screen.getByText("Continue with OAuth"))
    await waitFor(() => expect(setAuth).toHaveBeenCalledWith("figma", { type: "oauth" }))
  })

  it("opens the existing skill palette from the menu", () => {
    render(<Composer skills={[{ name: "/deploy", description: "Deploy the app", source: "skill" }]} />)

    openMenu()
    fireEvent.click(screen.getByRole("option", { name: SKILLS_ITEM }))
    expect(screen.getByText("/deploy")).toBeTruthy()
  })
})
