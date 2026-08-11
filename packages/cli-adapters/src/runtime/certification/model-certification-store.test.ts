import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  CURRENT_RUNTIME_CONTRACTS,
  certificationKey,
  type ModelCertification
} from "@jingler/core"
import { afterEach, describe, expect, it } from "vitest"
import {
  FileModelCertificationStore,
  InMemoryModelCertificationStore
} from "./model-certification-store.js"

const roots: Array<string> = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

const certification = (
  authKind: ModelCertification["authRoute"]["kind"],
  provenance: ModelCertification["provenance"] = "local"
): ModelCertification => ({
  providerId: authKind.startsWith("claude") ? "anthropic" : "openai",
  modelId: authKind.startsWith("claude") ? "anthropic/claude" : "openai/codex",
  authRoute: {
    kind: authKind,
    observedRoute: authKind,
    subscription: authKind !== "api-key" && authKind !== "device-environment",
    entitlementConfirmed: true,
    apiBillingFallbackObserved: false
  },
  versions: CURRENT_RUNTIME_CONTRACTS,
  provenance,
  capabilityProfiles: ["core"],
  results: [{ scenarioId: "core", status: "passed", failures: [], durationMs: 1, tokens: 1, costUsd: 0 }],
  certifiedAt: "2026-08-10T00:00:00.000Z"
})

describe("model certification store", () => {
  it("can start with fixture evidence without an asynchronous seed step", async () => {
    const evidence = certification("api-key")
    const store = new InMemoryModelCertificationStore([evidence])

    expect(await store.get(certificationKey(evidence))).toEqual(evidence)
  })

  it("keeps authentication routes as independent records", async () => {
    const store = new InMemoryModelCertificationStore()
    const oauth = certification("openai-codex-oauth")
    const api = certification("api-key")
    await store.put(oauth)
    await store.put(api)
    expect(await store.get(certificationKey(oauth))).toEqual(oauth)
    expect(await store.get(certificationKey(api))).toEqual(api)
    expect(await store.list()).toHaveLength(2)
  })

  it("merges a reviewed release manifest without duplicating an existing route", async () => {
    const store = new InMemoryModelCertificationStore()
    const local = certification("openai-codex-oauth")
    const reviewed = certification("openai-codex-oauth", "reviewed-release")
    await store.put(local)
    await store.putAll([
      reviewed,
      certification("claude-setup-token", "reviewed-release")
    ])

    expect(await store.list()).toEqual(expect.arrayContaining([
      reviewed,
      certification("claude-setup-token", "reviewed-release")
    ]))
    expect(await store.list()).toHaveLength(2)
  })

  it("persists concurrent updates atomically without losing a route", async () => {
    const root = await mkdtemp(join(tmpdir(), "jingler-certifications-"))
    roots.push(root)
    const file = join(root, "runtime", "certifications.json")
    const store = new FileModelCertificationStore(file)
    await Promise.all([
      store.put(certification("openai-codex-oauth")),
      store.put(certification("claude-setup-token"))
    ])
    expect(await store.list()).toHaveLength(2)
    const persisted = await readFile(file, "utf8")
    expect(() => JSON.parse(persisted)).not.toThrow()
  })

  it("invalidates records when a supplied contract version changes", async () => {
    const store = new InMemoryModelCertificationStore()
    await store.put(certification("openai-codex-oauth"))
    expect(await store.current({ ...CURRENT_RUNTIME_CONTRACTS, diff: "2" })).toEqual([])
  })
})
