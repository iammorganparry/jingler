import { existsSync, readFileSync, readdirSync } from "node:fs"
import { dirname, extname, relative, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..")
const sourceRoots = [
  "packages/cli-adapters/src",
  "packages/contracts/src",
  "apps/desktop/src",
  "apps/device-agent/src"
]

const sourceFiles = (directory: string): ReadonlyArray<string> =>
  readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(directory, entry.name)
    if (entry.isDirectory()) return sourceFiles(path)
    if (extname(path) !== ".ts" && extname(path) !== ".tsx") return []
    if (/\.(test|stories)\.[^.]+$/.test(path)) return []
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
      "packages/cli-adapters/src/subscription.ts"
    ]) {
      expect(existsSync(resolve(root, path)), path).toBe(false)
    }
  })

  it("does not import provider harness SDKs or discovery", () => {
    expect(offenders(/@anthropic-ai\/claude-agent-sdk|@openai\/codex-sdk|@opencode-ai\/sdk/)).toStrictEqual([])
    expect(offenders(/(?:from|import\()\s*["'][^"']*\/discovery(?:\.js)?["']/)).toStrictEqual([])
  })

  it("exposes no legacy harness RPC", () => {
    expect(offenders(/Agent\.setHarness|Discovery\.list|Models\.(?:list|catalog|capabilities)/)).toStrictEqual([])
  })

  it("keeps provider harness SDKs out of production dependencies", () => {
    const manifest = readFileSync(resolve(root, "packages/cli-adapters/package.json"), "utf8")
    expect(manifest).not.toContain("@anthropic-ai/claude-agent-sdk")
    expect(manifest).not.toContain("@openai/codex-sdk")
    expect(manifest).not.toContain("@opencode-ai/sdk")
  })
})
