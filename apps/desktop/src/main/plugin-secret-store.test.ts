import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { PluginSecretStore } from "@jingler/cli-adapters"
import { withTempRoot } from "@jingler/cli-adapters/test-support"
import { Effect, Layer } from "effect"
import { afterEach, describe, expect, it } from "vitest"
import {
  makeFilePluginSecretStore,
  type PluginSecretCodec
} from "./plugin-secret-store.js"

const roots: Array<ReturnType<typeof withTempRoot>> = []

afterEach(() => {
  for (const root of roots.splice(0)) root.cleanup()
})

const setup = (codec: PluginSecretCodec) => {
  const root = withTempRoot()
  roots.push(root)
  const layer = Layer.effect(PluginSecretStore, makeFilePluginSecretStore(codec)).pipe(
    Layer.provide(root.layer)
  )
  return { root, layer }
}

describe("file-backed PluginSecretStore", () => {
  it("persists encoded bytes and decrypts them on the next read", async () => {
    const codec: PluginSecretCodec = {
      available: () => true,
      encrypt: (value) => Buffer.from(Buffer.from(value).toString("base64"), "utf8"),
      decrypt: (value) =>
        Buffer.from(Buffer.from(value).toString("utf8"), "base64").toString("utf8")
    }
    const { root, layer } = setup(codec)

    await Effect.runPromise(
      Effect.gen(function* () {
        const store = yield* PluginSecretStore
        yield* store.set("linear", "linear.api-key", "lin_api_secret")
      }).pipe(Effect.provide(layer))
    )

    const bytes = await readFile(join(root.root, "plugin-secrets.enc"), "utf8")
    expect(bytes).not.toContain("lin_api_secret")

    const value = await Effect.runPromise(
      Effect.flatMap(PluginSecretStore, (store) =>
        store.get("linear", "linear.api-key")
      ).pipe(Effect.provide(layer))
    )
    expect(value).toBe("lin_api_secret")
  })

  it("surfaces an actionable failure when encryption is unavailable", async () => {
    const { layer } = setup({
      available: () => false,
      encrypt: () => new Uint8Array(),
      decrypt: () => "{}"
    })

    const exit = await Effect.runPromiseExit(
      Effect.flatMap(PluginSecretStore, (store) =>
        store.set("linear", "linear.api-key", "secret")
      ).pipe(Effect.provide(layer))
    )

    expect(exit._tag).toBe("Failure")
    expect(String(exit)).toContain("OS encryption is unavailable")
  })

  it("clears only the uninstalled plugin's namespace", async () => {
    const identity: PluginSecretCodec = {
      available: () => true,
      encrypt: (value) => Buffer.from(value),
      decrypt: (value) => Buffer.from(value).toString("utf8")
    }
    const { layer } = setup(identity)

    const values = await Effect.runPromise(
      Effect.gen(function* () {
        const store = yield* PluginSecretStore
        yield* store.set("linear", "linear.api-key", "linear-secret")
        yield* store.set("github", "github.token", "github-secret")
        yield* store.clearPlugin("linear")
        return yield* Effect.all([
          store.get("linear", "linear.api-key"),
          store.get("github", "github.token")
        ])
      }).pipe(Effect.provide(layer))
    )

    expect(values).toEqual([null, "github-secret"])
  })
})
