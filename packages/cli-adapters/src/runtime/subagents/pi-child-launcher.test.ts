import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect } from "effect"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import {
  JINGLER_SUBAGENT_CHILD_TOOLS,
  JINGLER_SUBAGENT_CLAUDE_PROVIDER_PATH,
  JINGLER_SUBAGENT_CREDENTIAL_ROOT,
  JINGLER_SUBAGENT_NODE,
  JINGLER_SUBAGENT_PROCESS_ISOLATION,
  PI_SUBAGENT_ELECTRON_RUN_AS_NODE,
  preparePiChildLauncher
} from "./pi-child-launcher.js"

const names = [
  JINGLER_SUBAGENT_PROCESS_ISOLATION,
  PI_SUBAGENT_ELECTRON_RUN_AS_NODE,
  JINGLER_SUBAGENT_CREDENTIAL_ROOT,
  JINGLER_SUBAGENT_CLAUDE_PROVIDER_PATH,
  JINGLER_SUBAGENT_NODE,
  JINGLER_SUBAGENT_CHILD_TOOLS
] as const
const original = Object.fromEntries(names.map((name) => [name, process.env[name]]))
const roots: string[] = []

beforeEach(() => {
  for (const name of names) delete process.env[name]
})
afterEach(async () => {
  for (const name of names) {
    const value = original[name]
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

const config = async () => {
  const root = await mkdtemp(join(tmpdir(), "jingler-child-launcher-"))
  roots.push(root)
  const childToolsPath = join(root, "child-tools.mjs")
  const claudeProviderPath = join(root, "claude-provider.mjs")
  await Promise.all([
    writeFile(childToolsPath, "export default () => {}\n"),
    writeFile(claudeProviderPath, "export default () => {}\n")
  ])
  return {
    credentialRoot: join(root, "credentials"),
    nodePath: process.execPath,
    childToolsPath,
    claudeProviderPath
  }
}

describe("preparePiChildLauncher", () => {
  it("pins the isolated child-session runtime", async () => {
    const input = await config()

    await Effect.runPromise(preparePiChildLauncher(input))

    expect(process.env.JINGLER_SUBAGENT_PROCESS_ISOLATION).toBe("1")
    expect(process.env.PI_SUBAGENT_ELECTRON_RUN_AS_NODE).toBe("1")
    expect(process.env.JINGLER_SUBAGENT_CREDENTIAL_ROOT).toBe(input.credentialRoot)
    expect(process.env.JINGLER_SUBAGENT_CLAUDE_PROVIDER_PATH).toBe(input.claudeProviderPath)
    expect(process.env.JINGLER_SUBAGENT_NODE).toBe(process.execPath)
    expect(process.env.JINGLER_SUBAGENT_CHILD_TOOLS).toBe(input.childToolsPath)
  })

  it("fails closed when another runtime already owns the launcher", async () => {
    const input = await config()
    process.env.JINGLER_SUBAGENT_NODE = join(input.credentialRoot, "other-node")

    const result = await Effect.runPromise(
      Effect.either(preparePiChildLauncher(input))
    )

    expect(result._tag).toBe("Left")
  })
})
