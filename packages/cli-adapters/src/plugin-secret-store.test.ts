import { Effect } from "effect"
import { describe, expect, it } from "vitest"
import { makeInMemoryPluginSecretStore } from "./plugin-secret-store.js"

describe("PluginSecretStore (in-memory)", () => {
  it("namespaces the same setting id by owning plugin", async () => {
    const values = await Effect.runPromise(
      Effect.gen(function* () {
        const store = yield* makeInMemoryPluginSecretStore()
        yield* store.set("linear", "api-key", "lin_secret")
        yield* store.set("other", "api-key", "other_secret")
        return yield* Effect.all([
          store.get("linear", "api-key"),
          store.get("other", "api-key")
        ])
      })
    )

    expect(values).toEqual(["lin_secret", "other_secret"])
  })

  it("reports configured state without returning the value", async () => {
    const statuses = await Effect.runPromise(
      Effect.gen(function* () {
        const store = yield* makeInMemoryPluginSecretStore()
        yield* store.set("linear", "linear.api-key", "lin_secret")
        return yield* Effect.all([
          store.status("linear", "linear.api-key"),
          store.status("linear", "linear.absent")
        ])
      })
    )

    expect(statuses).toEqual([true, false])
  })

  it("clears one setting without disturbing its siblings", async () => {
    const values = await Effect.runPromise(
      Effect.gen(function* () {
        const store = yield* makeInMemoryPluginSecretStore({
          linear: { "linear.api-key": "secret", "linear.webhook": "hook" }
        })
        yield* store.clear("linear", "linear.api-key")
        return yield* Effect.all([
          store.get("linear", "linear.api-key"),
          store.get("linear", "linear.webhook")
        ])
      })
    )

    expect(values).toEqual([null, "hook"])
  })

  it("clears every secret for one plugin on uninstall", async () => {
    const values = await Effect.runPromise(
      Effect.gen(function* () {
        const store = yield* makeInMemoryPluginSecretStore({
          linear: { "linear.api-key": "secret" },
          github: { "github.token": "other" }
        })
        yield* store.clearPlugin("linear")
        return yield* Effect.all([
          store.get("linear", "linear.api-key"),
          store.get("github", "github.token")
        ])
      })
    )

    expect(values).toEqual([null, "other"])
  })
})
