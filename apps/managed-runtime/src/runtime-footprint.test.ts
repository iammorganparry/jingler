/// <reference types="node" />

import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"

const readRuntimeFile = (name: string): string =>
  readFileSync(fileURLToPath(String(new URL(`../${name}`, import.meta.url))), "utf8")

describe("managed runtime dependency and cost footprint", () => {
  it("pins matching Sandbox SDK and container versions for RPC compatibility", () => {
    const packageJson = JSON.parse(readRuntimeFile("package.json")) as {
      dependencies: Record<string, string>
    }
    const dockerfile = readRuntimeFile("Dockerfile")
    const sdkVersion = packageJson.dependencies["@cloudflare/sandbox"]

    expect(sdkVersion).toBe("0.10.3")
    expect(dockerfile).toContain(`cloudflare/sandbox:${sdkVersion}`)
  })

  it("ships the two supported harnesses and never copies project dependency trees", () => {
    const dockerfile = readRuntimeFile("Dockerfile")
    expect(dockerfile.match(/npm install/gu)).toHaveLength(1)
    expect(dockerfile).toContain("@openai/codex@0.147.0")
    expect(dockerfile).toContain("@anthropic-ai/claude-code@2.1.227")
    expect(dockerfile).not.toMatch(/COPY .*node_modules|pnpm install|npm install (?!.*--global)/u)
  })

  it("keeps a hard global canary cap alongside per-user admission", () => {
    const wrangler = readRuntimeFile("wrangler.jsonc")
    expect(wrangler).toContain('"instance_type": "basic"')
    expect(wrangler).toContain('"max_instances": 10')
    expect(wrangler).toContain('"SANDBOX_TRANSPORT": "rpc"')
  })
})
