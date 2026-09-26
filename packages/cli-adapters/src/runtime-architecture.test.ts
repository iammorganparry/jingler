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
const PI_IDENTITY = /\bPiRunSpec\b|\bpiSessionId\b|\bparentPiSessionId\b/

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..")
const sourceRoots = ["packages", "apps", "plugins"].flatMap((group) =>
  readdirSync(resolve(root, group), { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(resolve(root, group, entry.name, "src")))
    .map((entry) => `${group}/${entry.name}/src`)
)

const sourceFiles = (directory: string): ReadonlyArray<string> =>
  readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(directory, entry.name)
    if (entry.isDirectory()) return sourceFiles(path)
    if (![".ts", ".tsx", ".js", ".mjs", ".cjs", ".mts", ".cts"].includes(extname(path))) return []
    if (TEST_SOURCE.test(path)) return []
    return [path]
  })

const productionSources = sourceRoots.flatMap((path) => sourceFiles(resolve(root, path)))

const offenders = (pattern: RegExp): ReadonlyArray<string> =>
  productionSources
    .filter((path) => pattern.test(readFileSync(path, "utf8")))
    .map((path) => relative(root, path))

describe("production runtime architecture", () => {
  it("isolates Codex protocol and implementation details behind adapter facades", () => {
    const protocol = /["'](?:thread\/(?:start|resume|fork)|turn\/(?:start|steer|interrupt)|account\/(?:read|login\/start|login\/cancel)|model\/list|app-server)["']|codex\/(?:generated|client|events|inbox)(?:\/|\.|["'])/u
    expect(offenders(protocol).filter((path) => !path.startsWith("packages/cli-adapters/src/runtime/codex/"))).toEqual([])
    const piImport = /(?:from|import\()\s*["'][^"']*(?:pi-ai|pi-coding-agent|pi-session|pi-runtime|pi-model|providers\/pi-)/u
    expect(offenders(piImport).filter((path) => path.startsWith("packages/cli-adapters/src/runtime/codex/"))).toEqual([])
  })

  it("does not restore legacy orchestration or SDK fallbacks", () => {
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

  it("keeps PI identity out of generic production contracts", () => {
    const allowed = new Set([
      "packages/cli-adapters/src/runtime/migration/legacy-runtime-identity.ts",
      "packages/cli-adapters/src/runtime/migration/legacy-subagent-control-journal.ts"
    ])
    expect(offenders(PI_IDENTITY).filter((path) => !allowed.has(path))).toStrictEqual([])
  })

  it("does not import provider harness SDKs or discovery", () => {
    expect(offenders(/@anthropic-ai\/claude-agent-sdk|@openai\/codex-sdk/)).toStrictEqual([])
    expect(offenders(/@opencode-ai\/sdk/).filter((path) => !path.startsWith("packages/cli-adapters/src/runtime/opencode/"))).toStrictEqual([])
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
    for (const source of sourceRoots) {
      const path = resolve(root, source, "../package.json")
      if (!existsSync(path)) continue
      const manifest = JSON.parse(readFileSync(path, "utf8"))
      const dependencies = { ...manifest.dependencies, ...manifest.optionalDependencies }
      expect(Object.keys(dependencies).filter((name) => PROVIDER_HARNESS_SDK.test(name) && !(source === "packages/cli-adapters/src" && name === "@opencode-ai/sdk")), path).toEqual([])
    }
  })
})

it("never parses native CLI credential files in production", () => {
  // Covers literal paths and join(home, vendor, filename) construction.
  const credentialPath = /\.credentials\.json|(?:\.codex|CODEX_HOME|opencode)[\s\S]{0,160}auth\.json|auth\.json[\s\S]{0,160}(?:\.codex|CODEX_HOME|opencode)/u
  expect(productionSources.filter(path => {
    const source = readFileSync(path, "utf8")
    // The sandbox denies access to these files; only its literal denylist is exempt.
    const checked = relative(root, path) === "packages/cli-adapters/src/sandbox.ts"
      ? source.replace(/^  "(?:\.local\/share\/opencode\/auth\.json|\.claude\/\.credentials\.json|\.codex\/auth\.json)",?$/gmu, "")
      : source
    return credentialPath.test(checked)
  }).map(path => relative(root, path))).toEqual([])
})
