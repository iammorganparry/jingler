#!/usr/bin/env node
import { createHash } from "node:crypto"
import { access, stat } from "node:fs/promises"
import { join } from "node:path"
import { spawn } from "node:child_process"

const required = (name) => {
  const value = process.env[name]?.trim()
  if (!value) throw new Error(`${name} is required by the Jingler subagent runtime`)
  return value
}

const parentSession = required("PI_SUBAGENT_PARENT_SESSION")
const credentialRoot = required("JINGLER_SUBAGENT_CREDENTIAL_ROOT")
const piCli = required("JINGLER_SUBAGENT_PI_CLI")
const nodePath = required("JINGLER_SUBAGENT_NODE")
const key = createHash("sha256").update(parentSession).digest("hex")
const agentDir = join(credentialRoot, key)
const authPath = join(agentDir, "auth.json")
await access(authPath)
if (process.platform !== "win32") {
  const mode = (await stat(authPath)).mode & 0o777
  if (mode !== 0o600) {
    throw new Error("Jingler child credential permissions are not restricted")
  }
}

const env = {
  ...process.env,
  ELECTRON_RUN_AS_NODE: "1",
  PI_CODING_AGENT_DIR: agentDir
}
delete env.JINGLER_SUBAGENT_CREDENTIAL_ROOT

const child = spawn(nodePath, [piCli, ...process.argv.slice(2)], {
  env,
  stdio: "inherit",
  windowsHide: true
})
child.once("error", (error) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
})
child.once("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal)
  else process.exitCode = code ?? 1
})
