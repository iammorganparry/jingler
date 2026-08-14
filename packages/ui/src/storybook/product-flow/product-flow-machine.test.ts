import { createActor } from "xstate"
import { describe, expect, it } from "vitest"
import { productFlowMachine } from "./product-flow-machine.js"

describe("mocked product journey", () => {
  it("walks the complete mocked operator journey", () => {
    const actor = createActor(productFlowMachine, {
      input: { startAt: "auth" }
    }).start()

    actor.send({ type: "AUTHENTICATE" })
    actor.send({ type: "CHOOSE_WORKSPACE" })
    actor.send({ type: "CONTINUE" })
    actor.send({ type: "CONNECT_GITHUB" })
    actor.send({
      type: "CONNECT_PROVIDER",
      authKind: "openai-codex-oauth"
    })
    expect(actor.getSnapshot().matches("providerConnecting")).toBe(true)
    actor.send({ type: "PROVIDER_CONNECTED" })
    actor.send({ type: "CONTINUE" })
    actor.send({ type: "IMPORT_RESOURCES" })

    expect(actor.getSnapshot().matches("app")).toBe(true)
    expect(actor.getSnapshot().context).toMatchObject({
      workspaceChosen: true,
      githubConnected: true,
      providerConnected: true,
      resourcesImported: true
    })
  })

  it("starts directly at a design-review checkpoint", () => {
    const actor = createActor(productFlowMachine, {
      input: { startAt: "provider" }
    }).start()

    expect(actor.getSnapshot().matches("provider")).toBe(true)
    expect(actor.getSnapshot().context.workspaceChosen).toBe(true)
    expect(actor.getSnapshot().context.providerConnected).toBe(false)
  })

  it("allows optional GitHub, provider, and resource setup to be skipped", () => {
    const actor = createActor(productFlowMachine, {
      input: { startAt: "github" }
    }).start()

    actor.send({ type: "SKIP_GITHUB" })
    actor.send({ type: "SKIP_PROVIDER" })
    actor.send({ type: "SKIP_RESOURCES" })

    expect(actor.getSnapshot().matches("app")).toBe(true)
    expect(actor.getSnapshot().context).toMatchObject({
      githubConnected: false,
      providerConnected: false,
      resourcesImported: false
    })
  })
})
