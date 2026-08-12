import { ProviderConnectionId } from "@jingler/core"
import { createActor } from "xstate"
import { describe, expect, it } from "vitest"
import { providerConnectionsSettingsMachine } from "./provider-connections-settings-machine.js"

const connectionId = (value: string) => ProviderConnectionId.make(value)

describe("providerConnectionsSettingsMachine", () => {
  it("opens the add form without losing that mode on an ordinary catalog refresh", () => {
    const existing = connectionId("existing")
    const actor = createActor(providerConnectionsSettingsMachine, {
      input: { connectionIds: [existing], defaultConnectionId: existing }
    }).start()

    actor.send({ type: "ADD" })
    actor.send({ type: "CATALOG_UPDATED", connectionIds: [existing] })

    expect(actor.getSnapshot().matches("adding")).toBe(true)
    expect(actor.getSnapshot().context.selectedId).toBeNull()
  })

  it("selects a connection created while adding", () => {
    const existing = connectionId("existing")
    const added = connectionId("added")
    const actor = createActor(providerConnectionsSettingsMachine, {
      input: { connectionIds: [existing], defaultConnectionId: existing }
    }).start()

    actor.send({ type: "ADD" })
    actor.send({ type: "CATALOG_UPDATED", connectionIds: [existing, added] })

    expect(actor.getSnapshot().matches("browsing")).toBe(true)
    expect(actor.getSnapshot().context.selectedId).toBe(added)
  })

  it("returns to adding when the final connection is removed", () => {
    const existing = connectionId("existing")
    const actor = createActor(providerConnectionsSettingsMachine, {
      input: { connectionIds: [existing], defaultConnectionId: existing }
    }).start()

    actor.send({ type: "CATALOG_UPDATED", connectionIds: [] })

    expect(actor.getSnapshot().matches("adding")).toBe(true)
    expect(actor.getSnapshot().context.selectedId).toBeNull()
  })
})
