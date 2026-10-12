import { cleanup, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { SettingsView } from "./settings-view.js"
import { userEvent } from "@testing-library/user-event"

afterEach(cleanup)

describe("SettingsView", () => {
  it("renders grouped navigation", () => {
    render(<SettingsView initialSection="general" />)
    
    // Group labels should be visible
    expect(screen.getByText("Workspace")).toBeTruthy()
    expect(screen.getByText("Agents")).toBeTruthy()
    expect(screen.getByText("Integrations")).toBeTruthy()
    expect(screen.getByText("Appearance")).toBeTruthy()
  })

  it("shows Soon pills for unready sections", () => {
    render(<SettingsView initialSection="general" />)
    
    // Permissions and Keybindings should show Soon pills
    const permissions = screen.getByRole("button", { name: "Permissions" })
    expect(permissions.textContent?.includes("Soon")).toBeTruthy()
    
    const keybindings = screen.getByRole("button", { name: "Keybindings" })
    expect(keybindings.textContent?.includes("Soon")).toBeTruthy()
  })

  it("filters nav items by search query", async () => {
    const user = userEvent.setup()
    render(<SettingsView initialSection="general" />)
    
    const searchField = screen.getByPlaceholderText("Search settings")
    
    // Initially all items are visible
    expect(screen.getByRole("button", { name: "General" })).toBeTruthy()
    expect(screen.getByRole("button", { name: "Providers" })).toBeTruthy()
    expect(screen.getByRole("button", { name: "Themes" })).toBeTruthy()
    
    // Search for "prov" should show only Providers
    await user.type(searchField, "prov")
    
    expect(screen.getByRole("button", { name: "Providers" })).toBeTruthy()
    expect(screen.queryByRole("button", { name: "General" })).toBeNull()
    expect(screen.queryByRole("button", { name: "Themes" })).toBeNull()
  })

  it("clears search on Escape", async () => {
    const user = userEvent.setup()
    render(<SettingsView initialSection="general" />)
    
    const searchField = screen.getByPlaceholderText("Search settings")
    
    await user.type(searchField, "prov")
    expect(screen.queryByRole("button", { name: "General" })).toBeNull()
    
    await user.keyboard("{Escape}")
    
    // After clearing, all items should be visible again
    expect(screen.getByRole("button", { name: "General" })).toBeTruthy()
    expect(screen.getByRole("button", { name: "Providers" })).toBeTruthy()
  })

  it("hides empty groups when filtering", async () => {
    const user = userEvent.setup()
    render(<SettingsView initialSection="general" />)
    
    const searchField = screen.getByPlaceholderText("Search settings")
    
    // Search for "github" - only Integrations group should remain
    await user.type(searchField, "github")
    
    expect(screen.queryByText("Workspace")).toBeNull()
    expect(screen.queryByText("Agents")).toBeNull()
    expect(screen.getByText("Integrations")).toBeTruthy()
    expect(screen.queryByText("Appearance")).toBeNull()
  })
})
