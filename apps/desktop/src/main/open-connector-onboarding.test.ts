import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { NodeContext } from "@effect/platform-node"
import {
  AppPaths,
  ConfigService,
  InMemorySecretStoreLive,
  OpenConnectorService
} from "@starbase/cli-adapters"
import { appPathsFor } from "@starbase/cli-adapters/test-support"
import { Effect, Layer } from "effect"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { openConnectorAutoSetup, openConnectorDefaults, openConnectorGet } from "./rpc.js"

/**
 * Onboarding: `openConnectorDefaults` is env-aware (the unit env has no Electron
 * `app`, so it resolves to the local/dev default), and `autoSetup` applies it —
 * in a dev build that means endpoint + dev token + enabled, so the operator is one
 * click from a working setup.
 */
describe("OpenConnector onboarding", () => {
  let root: string
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "oc-onboard-"))
  })
  afterEach(() => rmSync(root, { recursive: true, force: true }))

  const services = Layer.mergeAll(
    OpenConnectorService.Default,
    ConfigService.Default,
    InMemorySecretStoreLive
  )
  const envFor = () =>
    Layer.mergeAll(services, Layer.succeed(AppPaths, appPathsFor(root)), NodeContext.layer)

  const run = <A, E>(effect: Effect.Effect<A, E, never>) => Effect.runPromiseExit(effect)

  it("defaults to the local dev instance when there is no Electron app (test env)", () => {
    expect(openConnectorDefaults()).toEqual({
      endpoint: "http://localhost:3000",
      kind: "local",
      hasDevToken: true
    })
  })

  it("autoSetup enables the local endpoint with the dev token in one call", async () => {
    const exit = await run(
      Effect.gen(function* () {
        yield* openConnectorAutoSetup()
        return yield* openConnectorGet()
      }).pipe(Effect.provide(envFor()))
    )
    expect(exit._tag).toBe("Success")
    if (exit._tag === "Success") {
      expect(exit.value.config.endpoint).toBe("http://localhost:3000")
      expect(exit.value.config.enabled).toBe(true)
      expect(exit.value.hasToken).toBe(true)
      expect(exit.value.defaults.kind).toBe("local")
    }
  })
})
