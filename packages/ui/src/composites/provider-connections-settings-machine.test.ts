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

  it("cancelling the OAuth wait returns to browsing and clears the login id", () => {
    const existing = connectionId("existing")
    const actor = createActor(providerConnectionsSettingsMachine, {
      input: { connectionIds: [existing], defaultConnectionId: existing }
    }).start()

    actor.send({ type: "START_OAUTH", loginId: "login-1" })
    expect(actor.getSnapshot().matches("oauthWaitingFromBrowsing")).toBe(true)
    expect(actor.getSnapshot().context.oauthLoginId).toBe("login-1")

    actor.send({ type: "CANCEL" })

    expect(actor.getSnapshot().matches("browsing")).toBe(true)
    expect(actor.getSnapshot().context.oauthLoginId).toBeNull()
  })

  it("cancelling the OAuth wait started while adding returns to adding", () => {
    const actor = createActor(providerConnectionsSettingsMachine, {
      input: { connectionIds: [], defaultConnectionId: null }
    }).start()

    actor.send({ type: "START_OAUTH", loginId: "login-2" })
    expect(actor.getSnapshot().matches("oauthWaitingFromAdding")).toBe(true)

    actor.send({ type: "CANCEL" })

    expect(actor.getSnapshot().matches("adding")).toBe(true)
    expect(actor.getSnapshot().context.oauthLoginId).toBeNull()
  })

  it("keeps the typed API key value and surfaces the error when verification fails", () => {
    const existing = connectionId("existing")
    const actor = createActor(providerConnectionsSettingsMachine, {
      input: { connectionIds: [existing], defaultConnectionId: existing }
    }).start()

    actor.send({ type: "SUBMIT_API_KEY", value: "sk-bad-key" })
    actor.send({ type: "API_KEY_INVALID", error: "Invalid API key" })

    expect(actor.getSnapshot().context.apiKeyValue).toBe("sk-bad-key")
    expect(actor.getSnapshot().context.apiKeyError).toBe("Invalid API key")
  })

  it("clears the API key field once verification succeeds", () => {
    const existing = connectionId("existing")
    const actor = createActor(providerConnectionsSettingsMachine, {
      input: { connectionIds: [existing], defaultConnectionId: existing }
    }).start()

    actor.send({ type: "SUBMIT_API_KEY", value: "sk-good-key" })
    actor.send({ type: "API_KEY_VERIFIED" })

    expect(actor.getSnapshot().context.apiKeyValue).toBe("")
    expect(actor.getSnapshot().context.apiKeyError).toBeNull()
  })
})
