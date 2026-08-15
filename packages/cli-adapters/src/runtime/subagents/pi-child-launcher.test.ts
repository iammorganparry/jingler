import { execFile } from "node:child_process"
import { createHash } from "node:crypto"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"
import { Effect } from "effect"
import { afterEach, describe, expect, it } from "vitest"
import {
  JINGLER_SUBAGENT_CREDENTIAL_ROOT,
  JINGLER_SUBAGENT_NODE,
  JINGLER_SUBAGENT_PI_CLI,
  PI_SUBAGENT_PI_BINARY,
  preparePiChildLauncher
} from "./pi-child-launcher.js"

const runFile = promisify(execFile)
const roots: string[] = []
const names = [
  PI_SUBAGENT_PI_BINARY,
  JINGLER_SUBAGENT_PI_CLI,
  JINGLER_SUBAGENT_CREDENTIAL_ROOT,
  JINGLER_SUBAGENT_NODE
] as const
const original = Object.fromEntries(names.map((name) => [name, process.env[name]]))
afterEach(async () => {
  for (const name of names) {
    const value = original[name]
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
  await Promise.all(roots.splice(0).map((root) =>
    rm(root, { recursive: true, force: true })
  ))
})

describe("preparePiChildLauncher", () => {
  it("pins an explicit wrapper, Pi CLI, and credential root", async () => {
    const root = await mkdtemp(join(tmpdir(), "jingler-child-launcher-"))
    roots.push(root)
    const wrapperPath = join(root, "wrapper.mjs")
    const piCliPath = join(root, "cli.js")
    await Promise.all([
      writeFile(wrapperPath, "#!/usr/bin/env node\n"),
      writeFile(piCliPath, "")
    ])

    await Effect.runPromise(preparePiChildLauncher({
      wrapperPath,
      piCliPath,
      credentialRoot: join(root, "credentials"),
      nodePath: process.execPath
    }))

    expect(process.env.PI_SUBAGENT_PI_BINARY).toBe(wrapperPath)
    expect(process.env.JINGLER_SUBAGENT_PI_CLI).toBe(piCliPath)
    expect(process.env.JINGLER_SUBAGENT_CREDENTIAL_ROOT).toBe(
      join(root, "credentials")
    )
    expect(process.env.JINGLER_SUBAGENT_NODE).toBe(process.execPath)
  })

  it("launches Pi with only the parent session credential directory", async () => {
    const root = await mkdtemp(join(tmpdir(), "jingler-child-wrapper-"))
    roots.push(root)
    const parent = "parent-session"
    const credentialRoot = join(root, "credentials")
    const agentDir = join(
      credentialRoot,
      createHash("sha256").update(parent).digest("hex")
    )
    const output = join(root, "output.json")
    const fakeCli = join(root, "fake-cli.mjs")
    await mkdir(agentDir, { recursive: true })
    await writeFile(join(agentDir, "auth.json"), "{}\n", { mode: 0o600 })
    await writeFile(
      fakeCli,
      `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(output)}, JSON.stringify({ agentDir: process.env.PI_CODING_AGENT_DIR, args: process.argv.slice(2) }))`
    )

    await runFile(process.execPath, [
      new URL("../../../runtime-assets/pi-subagent-wrapper.mjs", import.meta.url)
        .pathname,
      "--model",
      "anthropic/test"
    ], {
      env: {
        ...process.env,
        PI_SUBAGENT_PARENT_SESSION: parent,
        JINGLER_SUBAGENT_CREDENTIAL_ROOT: credentialRoot,
        JINGLER_SUBAGENT_PI_CLI: fakeCli,
        JINGLER_SUBAGENT_NODE: process.execPath
      }
    })

    expect(JSON.parse(await readFile(output, "utf8"))).toEqual({
      agentDir,
      args: ["--model", "anthropic/test"]
    })
  })

  it("fails closed when another runtime already owns the launcher", async () => {
    const root = await mkdtemp(join(tmpdir(), "jingler-child-launcher-"))
    roots.push(root)
    const wrapperPath = join(root, "wrapper.mjs")
    const piCliPath = join(root, "cli.js")
    await Promise.all([writeFile(wrapperPath, ""), writeFile(piCliPath, "")])
    process.env.PI_SUBAGENT_PI_BINARY = join(root, "other")

    const result = await Effect.runPromise(
      Effect.either(preparePiChildLauncher({
        wrapperPath,
        piCliPath,
        credentialRoot: join(root, "credentials"),
      nodePath: process.execPath
      }))
    )

    expect(result._tag).toBe("Left")
  })
})
