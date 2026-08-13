import { existsSync, readFileSync, readdirSync } from "node:fs"
import { dirname, extname, relative, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"

const TEST_SOURCE = /\.(test|stories)\.[^.]+$/
const PROVIDER_HARNESS_SDK = /@anthropic-ai\/claude-agent-sdk|@openai\/codex-sdk|@opencode-ai\/sdk/
const DISCOVERY_IMPORT = /(?:from|import\()\s*["'][^"']*\/discovery(?:\.js)?["']/
const LEGACY_HARNESS_RPC = /Agent\.setHarness|Discovery\.list|Models\.(?:list|catalog|capabilities)/
const LEGACY_HARNESS_IDENTITY = /\b(?:CliKind|CliInfo|binPath|setHarness)\b/
const LEGACY_IDENTITY_MIGRATION = /runtime\/migration\/legacy-runtime-identity/

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..")
const sourceRoots = [
  "packages/cli-adapters/src",
  "packages/core/src",
  "packages/contracts/src",
  "apps/desktop/src",
  "apps/device-agent/src"
]

const sourceFiles = (directory: string): ReadonlyArray<string> =>
  readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(directory, entry.name)
    if (entry.isDirectory()) return sourceFiles(path)
    if (extname(path) !== ".ts" && extname(path) !== ".tsx") return []
    if (TEST_SOURCE.test(path)) return []
    return [path]
  })

const productionSources = sourceRoots.flatMap((path) => sourceFiles(resolve(root, path)))

const offenders = (pattern: RegExp): ReadonlyArray<string> =>
  productionSources
    .filter((path) => pattern.test(readFileSync(path, "utf8")))
    .map((path) => relative(root, path))

describe("production runtime architecture", () => {
  it("contains no provider-owned harness implementation", () => {
    for (const path of [
      "packages/cli-adapters/src/harness-adapter.ts",
      "packages/cli-adapters/src/claude-adapter.ts",
      "packages/cli-adapters/src/codex-adapter.ts",
      "packages/cli-adapters/src/opencode-adapter.ts",
      "packages/cli-adapters/src/discovery.ts",
      "packages/cli-adapters/src/subscription.ts",
      "packages/cli-adapters/src/codex-file-change.ts",
      "apps/desktop/src/main/transcript-backfill.ts"
    ]) {
      expect(existsSync(resolve(root, path)), path).toBe(false)
    }
  })

  it("does not import provider harness SDKs or discovery", () => {
    expect(offenders(PROVIDER_HARNESS_SDK)).toStrictEqual([])
    expect(offenders(DISCOVERY_IMPORT)).toStrictEqual([])
  })

  it("exposes no legacy harness RPC", () => {
    expect(offenders(LEGACY_HARNESS_RPC)).toStrictEqual([])
    expect(offenders(LEGACY_HARNESS_IDENTITY)).toStrictEqual([])
  })

  it("isolates legacy identity migration from production runtime modules", () => {
    const allowedImporters = new Set([
      "packages/cli-adapters/src/config.ts",
      "packages/cli-adapters/src/sessions.ts"
    ])
    const migrationImporters = offenders(LEGACY_IDENTITY_MIGRATION)
    expect(migrationImporters.filter((path) => !allowedImporters.has(path))).toStrictEqual([])
  })

  it("keeps provider harness SDKs out of production dependencies", () => {
    const manifest = readFileSync(resolve(root, "packages/cli-adapters/package.json"), "utf8")
    expect(manifest).not.toContain("@anthropic-ai/claude-agent-sdk")
    expect(manifest).not.toContain("@openai/codex-sdk")
    expect(manifest).not.toContain("@opencode-ai/sdk")
  })
})
