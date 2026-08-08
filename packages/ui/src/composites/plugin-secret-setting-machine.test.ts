import { createActor } from "xstate"
import { describe, expect, it, vi } from "vitest"
import { pluginSecretSettingMachine } from "./plugin-secret-setting-machine.js"

const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

describe("pluginSecretSettingMachine", () => {
  it("replaces without loading the saved value into the draft", async () => {
    const save = vi.fn(async () => undefined)
    const actor = createActor(pluginSecretSettingMachine, {
      input: { configured: true, save, clear: async () => undefined }
    }).start()

    expect(actor.getSnapshot().matches("configured")).toBe(true)
    actor.send({ type: "REPLACE" })
    expect(actor.getSnapshot().context.draft).toBe("")
    actor.send({ type: "CHANGE", value: "replacement" })
    actor.send({ type: "SAVE" })
    await settle()

    expect(save).toHaveBeenCalledWith("replacement")
    expect(actor.getSnapshot().matches("configured")).toBe(true)
    expect(actor.getSnapshot().context.draft).toBe("")
  })

  it("moves to an empty editor after removing the configured secret", async () => {
    const clear = vi.fn(async () => undefined)
    const actor = createActor(pluginSecretSettingMachine, {
      input: { configured: true, save: async () => undefined, clear }
    }).start()

    actor.send({ type: "REMOVE" })
    await settle()

    expect(clear).toHaveBeenCalledOnce()
    expect(actor.getSnapshot().matches("editing")).toBe(true)
    expect(actor.getSnapshot().context.configured).toBe(false)
  })

  it("keeps the replacement draft when persistence fails", async () => {
    const actor = createActor(pluginSecretSettingMachine, {
      input: {
        configured: true,
        save: async () => {
          throw new Error("vault unavailable")
        },
        clear: async () => undefined
      }
    }).start()

    actor.send({ type: "REPLACE" })
    actor.send({ type: "CHANGE", value: "keep-me" })
    actor.send({ type: "SAVE" })
    await settle()

    expect(actor.getSnapshot().matches("editing")).toBe(true)
    expect(actor.getSnapshot().context.draft).toBe("keep-me")
  })
})
