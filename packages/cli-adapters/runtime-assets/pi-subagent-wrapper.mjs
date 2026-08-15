import { createHash } from "node:crypto"
import { spawn } from "node:child_process"
import { access, stat } from "node:fs/promises"
import { join } from "node:path"

const SAFE_AGENT_NAME = /^[a-z][a-z0-9-]*$/u
const FORCE_KILL_AFTER_MS = 1_500

const required = (name) => {
  const value = process.env[name]?.trim()
  if (!value) throw new Error(`${name} is required by the Jingler subagent runtime`)
  return value
}

const parentSession = required("PI_SUBAGENT_PARENT_SESSION")
const childAgent = required("PI_SUBAGENT_CHILD_AGENT")
if (!SAFE_AGENT_NAME.test(childAgent)) {
  throw new Error("PI_SUBAGENT_CHILD_AGENT is invalid")
}
const credentialRoot = required("JINGLER_SUBAGENT_CREDENTIAL_ROOT")
const piCli = required("JINGLER_SUBAGENT_PI_CLI")
const nodePath = required("JINGLER_SUBAGENT_NODE")
const key = createHash("sha256").update(parentSession).digest("hex")
const agentDir = join(credentialRoot, key)
const authPath = join(agentDir, "auth.json")
const capabilityPath = join(agentDir, `capability-${childAgent}.json`)
await Promise.all([access(authPath), access(capabilityPath), access(piCli), access(nodePath)])
if (process.platform !== "win32") {
  const modes = await Promise.all([authPath, capabilityPath].map(async (path) =>
    (await stat(path)).mode & 0o777
  ))
  if (modes.some((mode) => mode !== 0o600)) {
    throw new Error("Jingler child credential permissions are not restricted")
  }
}

const env = {
  ...process.env,
  ELECTRON_RUN_AS_NODE: "1",
  PI_CODING_AGENT_DIR: agentDir,
  JINGLER_SUBAGENT_CAPABILITY: capabilityPath
}
delete env.JINGLER_SUBAGENT_CREDENTIAL_ROOT

const child = spawn(nodePath, [piCli, ...process.argv.slice(2)], {
  env,
  stdio: "inherit",
  windowsHide: true
})
let forceKillTimer = null
let terminating = false
const forwardedSignals = ["SIGINT", "SIGTERM", "SIGHUP"]
const forwardSignal = (signal) => {
  if (terminating) return
  terminating = true
  if (child.exitCode === null && child.signalCode === null) {
    child.kill(signal)
    forceKillTimer = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL")
    }, FORCE_KILL_AFTER_MS)
    forceKillTimer.unref()
  }
}
for (const signal of forwardedSignals) process.once(signal, () => forwardSignal(signal))

child.once("error", (error) => {
  if (forceKillTimer !== null) clearTimeout(forceKillTimer)
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
})
child.once("exit", (code, signal) => {
  if (forceKillTimer !== null) clearTimeout(forceKillTimer)
  for (const forwardedSignal of forwardedSignals) {
    process.removeAllListeners(forwardedSignal)
  }
  if (terminating || signal) process.exitCode = 1
  else process.exitCode = code ?? 1
})
