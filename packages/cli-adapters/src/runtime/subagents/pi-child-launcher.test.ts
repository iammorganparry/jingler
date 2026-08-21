import { execFile, spawn } from "node:child_process"
import { createHash } from "node:crypto"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"
import { Effect } from "effect"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import {
  JINGLER_SUBAGENT_CHILD_TOOLS,
  JINGLER_SUBAGENT_CREDENTIAL_ROOT,
  JINGLER_SUBAGENT_NODE,
  JINGLER_SUBAGENT_PI_CLI,
  PI_SUBAGENT_PI_BINARY,
  PI_SUBAGENT_PI_BINARY_ARGS,
  PI_SUBAGENT_ELECTRON_RUN_AS_NODE,
  preparePiChildLauncher
} from "./pi-child-launcher.js"

const runFile = promisify(execFile)
const roots: string[] = []
const names = [
  PI_SUBAGENT_PI_BINARY,
  PI_SUBAGENT_PI_BINARY_ARGS,
  PI_SUBAGENT_ELECTRON_RUN_AS_NODE,
  JINGLER_SUBAGENT_PI_CLI,
  JINGLER_SUBAGENT_CREDENTIAL_ROOT,
  JINGLER_SUBAGENT_NODE,
  JINGLER_SUBAGENT_CHILD_TOOLS
] as const
const original = Object.fromEntries(names.map((name) => [name, process.env[name]]))
const restoreEnvironment = () => {
  for (const name of names) {
    const value = original[name]
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
}
beforeEach(() => {
  for (const name of names) delete process.env[name]
})
afterEach(async () => {
  restoreEnvironment()
  await Promise.all(roots.splice(0).map((root) =>
    rm(root, { recursive: true, force: true })
  ))
})

const prepareChildFiles = async (
  root: string,
  parent = "parent-session",
  agent = "worker"
): Promise<{ readonly credentialRoot: string; readonly agentDir: string }> => {
  const credentialRoot = join(root, "credentials")
  const agentDir = join(
    credentialRoot,
    createHash("sha256").update(parent).digest("hex")
  )
  await mkdir(agentDir, { recursive: true })
  await Promise.all([
    writeFile(join(agentDir, "auth.json"), "{}\n", { mode: 0o600 }),
    writeFile(join(agentDir, `capability-${agent}.json`), JSON.stringify({
      version: 1,
      tools: [{ id: "workspace_read_file" }]
    }), { mode: 0o600 })
  ])
  return { credentialRoot, agentDir }
}

const wrapperPath = new URL(
  "../../../runtime-assets/pi-subagent-wrapper.mjs",
  import.meta.url
).pathname

describe("preparePiChildLauncher", () => {
  it("pins Node plus explicit wrapper arguments, Pi CLI, and credential root", async () => {
    const root = await mkdtemp(join(tmpdir(), "jingler-child-launcher-"))
    roots.push(root)
    const wrapper = join(root, "wrapper.mjs")
    const piCliPath = join(root, "cli.js")
    await Promise.all([
      writeFile(wrapper, "export {}\n"),
      writeFile(piCliPath, "")
    ])

    await Effect.runPromise(preparePiChildLauncher({
      wrapperPath: wrapper,
      piCliPath,
      credentialRoot: join(root, "credentials"),
      nodePath: process.execPath,
      childToolsPath: piCliPath
    }))

    expect(process.env.PI_SUBAGENT_PI_BINARY).toBe(process.execPath)
    expect(JSON.parse(process.env.PI_SUBAGENT_PI_BINARY_ARGS ?? "null"))
      .toEqual([wrapper])
    expect(process.env.PI_SUBAGENT_ELECTRON_RUN_AS_NODE).toBe("1")
    expect(process.env.JINGLER_SUBAGENT_PI_CLI).toBe(piCliPath)
    expect(process.env.JINGLER_SUBAGENT_CREDENTIAL_ROOT).toBe(
      join(root, "credentials")
    )
    expect(process.env.JINGLER_SUBAGENT_NODE).toBe(process.execPath)
    expect(process.env.JINGLER_SUBAGENT_CHILD_TOOLS).toBe(piCliPath)
  })

  it("launches Pi with the exact child profile and no ambient PATH", async () => {
    const root = await mkdtemp(join(tmpdir(), "jingler-child-wrapper-"))
    roots.push(root)
    const parent = "parent-session"
    const { credentialRoot, agentDir } = await prepareChildFiles(root, parent, "reviewer")
    const output = join(root, "output.json")
    const fakeCli = join(root, "fake-cli.mjs")
    await writeFile(
      fakeCli,
      `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(output)}, JSON.stringify({ agentDir: process.env.PI_CODING_AGENT_DIR, capability: process.env.JINGLER_SUBAGENT_CAPABILITY, args: process.argv.slice(2) }))`
    )

    await runFile(
      process.execPath,
      [wrapperPath, "--model", "anthropic/test", "--tools", "contact_supervisor"],
      {
        env: {
          PATH: "",
          PI_SUBAGENT_PARENT_SESSION: parent,
          PI_SUBAGENT_CHILD_AGENT: "reviewer",
          JINGLER_SUBAGENT_CREDENTIAL_ROOT: credentialRoot,
          JINGLER_SUBAGENT_PI_CLI: fakeCli,
          JINGLER_SUBAGENT_NODE: process.execPath
        }
      }
    )

    expect(JSON.parse(await readFile(output, "utf8"))).toEqual({
      agentDir,
      capability: join(agentDir, "capability-reviewer.json"),
      args: [
        "--model",
        "anthropic/test",
        "--tools",
        "contact_supervisor,workspace_read_file"
      ]
    })
  })

  it("forwards termination and force-kills a child that ignores it", async () => {
    if (process.platform === "win32") return
    const root = await mkdtemp(join(tmpdir(), "jingler-child-signal-"))
    roots.push(root)
    const parent = "parent-session"
    const { credentialRoot } = await prepareChildFiles(root, parent)
    const pidPath = join(root, "child.pid")
    const fakeCli = join(root, "stubborn-cli.mjs")
    await writeFile(
      fakeCli,
      `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(pidPath)}, String(process.pid)); process.on("SIGTERM", () => {}); setInterval(() => {}, 1000)`
    )
    const wrapper = spawn(process.execPath, [wrapperPath], {
      env: {
        ...process.env,
        PI_SUBAGENT_PARENT_SESSION: parent,
        PI_SUBAGENT_CHILD_AGENT: "worker",
        JINGLER_SUBAGENT_CREDENTIAL_ROOT: credentialRoot,
        JINGLER_SUBAGENT_PI_CLI: fakeCli,
        JINGLER_SUBAGENT_NODE: process.execPath
      },
      stdio: "ignore"
    })
    for (let attempt = 0; attempt < 100; attempt++) {
      try {
        await readFile(pidPath, "utf8")
        break
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 20))
      }
    }
    const childPid = Number(await readFile(pidPath, "utf8"))
    wrapper.kill("SIGTERM")
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("wrapper did not exit")), 4_000)
      wrapper.once("exit", () => {
        clearTimeout(timeout)
        resolve()
      })
    })
    expect(() => process.kill(childPid, 0)).toThrow()
  }, 6_000)

  it("fails closed when another runtime already owns the launcher", async () => {
    const root = await mkdtemp(join(tmpdir(), "jingler-child-launcher-"))
    roots.push(root)
    const wrapper = join(root, "wrapper.mjs")
    const piCliPath = join(root, "cli.js")
    await Promise.all([writeFile(wrapper, ""), writeFile(piCliPath, "")])
    process.env.PI_SUBAGENT_PI_BINARY = join(root, "other")

    const result = await Effect.runPromise(
      Effect.either(preparePiChildLauncher({
        wrapperPath: wrapper,
        piCliPath,
        credentialRoot: join(root, "credentials"),
        nodePath: process.execPath,
        childToolsPath: piCliPath
      }))
    )

    expect(result._tag).toBe("Left")
  })
})
