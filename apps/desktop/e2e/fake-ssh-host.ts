import { chmodSync, mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"

export interface FakeSshHostOptions {
  readonly binDir: string
  readonly desktopHome: string
  readonly deviceHome: string
  readonly deviceAgentBundle: string
  readonly relayUrl: string
}

/**
 * Installs a hermetic `buildbox` SSH target. The production bootstrap still
 * invokes `ssh` with its real argv; this shim only replaces the transport and
 * runs the shipped device-agent bundle in an isolated remote home.
 */
export const installFakeSshHost = (options: FakeSshHostOptions): void => {
  const sshDir = join(options.desktopHome, ".ssh")
  mkdirSync(sshDir, { recursive: true, mode: 0o700 })
  writeFileSync(join(sshDir, "config"), "Host buildbox\n  HostName 127.0.0.1\n  User jingler-e2e\n  Port 22\n", {
    mode: 0o600
  })
  writeFileSync(
    join(sshDir, "known_hosts"),
    "buildbox ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIE2Efixtureonlynotarealhostkey000000\n",
    { mode: 0o600 }
  )

  const script = `#!/usr/bin/env node
const { spawnSync } = require("node:child_process")
const fs = require("node:fs")
const log = process.env.JINGLER_E2E_SSH_LOG
if (log) fs.appendFileSync(log, JSON.stringify(process.argv.slice(2)) + "\\n")
const command = process.argv.at(-1) || ""
if (command.includes("jingler-device") && (command.includes(" serve ") || command.includes(" install-service "))) {
  process.exit(0)
}
if (!command.includes(" enroll ")) {
  process.stderr.write("unsupported fake SSH command\\n")
  process.exit(127)
}
let credential = ""
process.stdin.setEncoding("utf8")
process.stdin.on("data", (chunk) => { credential += chunk })
process.stdin.on("end", () => {
const result = spawnSync(process.execPath, [${JSON.stringify(options.deviceAgentBundle)}, "enroll", "--server", ${JSON.stringify(options.relayUrl)}, "--name", "buildbox"], {
  env: { ...process.env, JINGLER_HOME: ${JSON.stringify(options.deviceHome)}, JINGLER_DEVICE_RELAY_URL: ${JSON.stringify(options.relayUrl)}, JINGLER_SCRIPTED_AGENT: "1", JINGLER_E2E: "1" },
  input: credential,
  encoding: "utf8"
})
process.stdout.write(result.stdout || "")
process.stderr.write(result.stderr || "")
if (log && result.stderr) fs.appendFileSync(log, JSON.stringify({ agentStderr: result.stderr }) + "\\n")
process.exit(result.status ?? 1)
})
`
  const sshPath = join(options.binDir, "ssh")
  writeFileSync(sshPath, script)
  chmodSync(sshPath, 0o755)

  const scpScript = `#!/usr/bin/env node
const fs = require("node:fs")
const log = process.env.JINGLER_E2E_SSH_LOG
if (log) fs.appendFileSync(log, JSON.stringify(process.argv.slice(2)) + "\\n")
process.exit(0)
`
  const scpPath = join(options.binDir, "scp")
  writeFileSync(scpPath, scpScript)
  chmodSync(scpPath, 0o755)
}
