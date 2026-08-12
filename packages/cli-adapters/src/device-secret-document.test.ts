import { Effect } from "effect"
import { describe, expect, it } from "vitest"
import type { SecretStoreShape } from "./secret-store.js"
import { updateDeviceSecretDocument } from "./device-secret-document.js"

const delay = (milliseconds: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, milliseconds))

describe("device secret document", () => {
  it("serializes updates from distinct services sharing one encrypted vault", async () => {
    let document: string | null = null
    const store = (writeDelay: number): SecretStoreShape => ({
      get: Effect.succeed(null),
      set: () => Effect.void,
      clear: Effect.void,
      getOpenConnectorToken: Effect.succeed(null),
      setOpenConnectorToken: () => Effect.void,
      clearOpenConnectorToken: Effect.void,
      getDeviceSecrets: Effect.sync(() => document),
      setDeviceSecrets: (value) =>
        Effect.promise(async () => {
          await delay(writeDelay)
          document = value
        }),
      clearDeviceSecrets: Effect.sync(() => {
        document = null
      })
    })

    await Promise.all([
      updateDeviceSecretDocument(store(10), (current) => ({
        ...current,
        clientInstanceId: "client_desktop"
      })),
      updateDeviceSecretDocument(store(20), (current) => ({
        ...current,
        agentCredentials: { connection: { authKind: "openai-codex-oauth" } }
      }))
    ])

    expect(JSON.parse(document ?? "{}")).toEqual({
      clientInstanceId: "client_desktop",
      agentCredentials: { connection: { authKind: "openai-codex-oauth" } }
    })
  })
})
