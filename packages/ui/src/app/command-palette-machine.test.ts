import { createActor } from "xstate"
import { describe, expect, it } from "vitest"
import { commandPaletteMachine } from "./command-palette-machine.js"
import { itemsInScope, type PaletteItem } from "./command-palette-model.js"

const start = () => createActor(commandPaletteMachine).start()

describe("commandPaletteMachine", () => {
  it("a '>' prefix switches scope to commands and shows no query text", () => {
    const actor = start()
    actor.send({ type: "QUERY_CHANGED", value: ">" })
    expect(actor.getSnapshot().context).toMatchObject({
      scope: "commands",
      query: "",
      prefixActive: true
    })
  })

  it("an '@' prefix switches scope to files; a '#' prefix switches to sessions", () => {
    const at = start()
    at.send({ type: "QUERY_CHANGED", value: "@" })
    expect(at.getSnapshot().context.scope).toBe("files")

    const hash = start()
    hash.send({ type: "QUERY_CHANGED", value: "#" })
    expect(hash.getSnapshot().context.scope).toBe("sessions")
  })

  it("a prefix character typed after other text is literal, not a scope switch", () => {
    const actor = start()
    actor.send({ type: "QUERY_CHANGED", value: "a" })
    actor.send({ type: "QUERY_CHANGED", value: "a>" })
    expect(actor.getSnapshot().context).toMatchObject({ scope: "workspace", query: "a>" })
  })

  it("Backspace on an empty input clears an active prefix scope back to workspace", () => {
    const actor = start()
    actor.send({ type: "QUERY_CHANGED", value: ">" })
    actor.send({ type: "BACKSPACE_EMPTY" })
    expect(actor.getSnapshot().context).toMatchObject({ scope: "workspace", prefixActive: false })
  })

  it("Backspace on an empty input does nothing when no prefix is active", () => {
    const actor = start()
    actor.send({ type: "SET_SCOPE", scope: "chat" })
    actor.send({ type: "BACKSPACE_EMPTY" })
    expect(actor.getSnapshot().context.scope).toBe("chat")
  })

  it("Tab cycles Workspace/Chat but is a no-op while a prefix scope is active", () => {
    const actor = start()
    actor.send({ type: "CYCLE_SCOPE" })
    expect(actor.getSnapshot().context.scope).toBe("chat")

    actor.send({ type: "QUERY_CHANGED", value: ">" })
    actor.send({ type: "CYCLE_SCOPE" })
    expect(actor.getSnapshot().context.scope).toBe("commands")
  })

  it("RESET returns to the initial, per-opening state", () => {
    const actor = start()
    actor.send({ type: "QUERY_CHANGED", value: "#" })
    actor.send({ type: "RESET" })
    expect(actor.getSnapshot().context).toMatchObject({
      scope: "workspace",
      query: "",
      prefixActive: false
    })
  })

  it("the chat scope filters by explicit item.scope, never by group name", () => {
    const chatTab: PaletteItem = {
      id: "tab:terminal",
      kind: "tab",
      label: "Go to Terminal",
      group: "Chat things",
      scope: "chat",
      run: () => {}
    }
    const impostor: PaletteItem = {
      id: "action:fake-chat",
      kind: "action",
      label: "Looks like chat",
      group: "Chat things",
      run: () => {}
    }
    const result = itemsInScope([chatTab, impostor], "chat")
    expect(result).toEqual([chatTab])
  })

  it("plugin rows are filtered by their explicit scope, not swept into 'commands' by kind alone", () => {
    const pluginRow: PaletteItem = {
      id: "plugin:github.open-pr",
      kind: "plugin",
      label: "Open PR",
      group: "GitHub",
      scope: "workspace",
      run: () => {}
    }
    expect(itemsInScope([pluginRow], "commands")).toEqual([pluginRow])
    expect(itemsInScope([pluginRow], "chat")).toEqual([])
  })
})
