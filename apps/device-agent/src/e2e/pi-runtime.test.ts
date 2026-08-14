import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { loadDeviceE2ePiRuntime } from "./pi-runtime.js"

const roots: Array<string> = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe("device e2e pi runtime", () => {
  it("stays disabled unless every explicit e2e boundary value is present", () => {
    expect(loadDeviceE2ePiRuntime("device-1", {})).toBeNull()
    expect(loadDeviceE2ePiRuntime("device-1", { JINGLER_E2E: "1" })).toBeNull()
  })

  it("pins the deterministic connection and certification to the device target", async () => {
    const root = await mkdtemp(join(tmpdir(), "jingler-device-e2e-pi-"))
    roots.push(root)
    const fixture = join(root, "fixture.json")
    await writeFile(fixture, JSON.stringify({ scenarioId: "default", authRoute: "api-key" }))

    const runtime = loadDeviceE2ePiRuntime("device-1", {
      JINGLER_E2E: "1",
      JINGLER_E2E_PI_FIXTURE: fixture,
      JINGLER_E2E_PI_CONNECTION_ID: "connection-1",
      JINGLER_E2E_PI_PROVIDER_ID: "jingler-e2e",
      JINGLER_E2E_PI_MODEL_ID: "jingler-e2e/eval-model"
    })

    expect(runtime?.providers.connections).toEqual([
      expect.objectContaining({ id: "connection-1", targetId: "device-1" })
    ])
    expect(await runtime?.providers.certifications.list()).toEqual([
      expect.objectContaining({ modelId: "jingler-e2e/eval-model" })
    ])
  })
})
