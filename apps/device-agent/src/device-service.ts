import { spawn } from "node:child_process"
import { chmod, mkdir, rename, rm, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, join } from "node:path"

export interface DeviceServiceCommandResult {
  readonly exitCode: number
  readonly stderr: string
}

export interface DeviceServiceCommandRunner {
  readonly run: (binary: string, args: ReadonlyArray<string>) => Promise<DeviceServiceCommandResult>
}

export interface InstallDeviceServiceInput {
  readonly platform?: NodeJS.Platform
  readonly uid?: number
  readonly home?: string
  readonly nodePath?: string
  readonly agentPath?: string
  readonly jinglerHome?: string
}

export interface InstalledDeviceService {
  readonly manager: "launchd" | "systemd"
  readonly definitionPath: string
}

export interface RemoveDeviceServiceInput {
  readonly platform?: NodeJS.Platform
  readonly uid?: number
  readonly home?: string
  readonly stop?: boolean
}

const LABEL = "app.jingler.device-agent"

export const nodeDeviceServiceCommandRunner: DeviceServiceCommandRunner = {
  run: (binary, args) =>
    new Promise((resolve, reject) => {
      const child = spawn(binary, [...args], {
        shell: false,
        stdio: ["ignore", "ignore", "pipe"]
      })
      let stderr = ""
      child.stderr.setEncoding("utf8")
      child.stderr.on("data", (chunk: string) => {
        stderr += chunk
      })
      child.once("error", reject)
      child.once("close", (exitCode) => resolve({ exitCode: exitCode ?? 1, stderr }))
    })
}

const atomicWrite = async (path: string, contents: string): Promise<void> => {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  const temporary = `${path}.${process.pid}.tmp`
  await writeFile(temporary, contents, { mode: 0o600, flag: "w" })
  await chmod(temporary, 0o600)
  await rename(temporary, path)
}

const xml = (value: string): string =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;")

const launchdDefinition = (
  nodePath: string,
  agentPath: string,
  logPath: string,
  jinglerHome: string | undefined
): string => `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array><string>${xml(nodePath)}</string><string>${xml(agentPath)}</string><string>serve</string></array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
  <key>ProcessType</key><string>Background</string>
  <key>StandardOutPath</key><string>${xml(logPath)}</string>
  <key>StandardErrorPath</key><string>${xml(logPath)}</string>
  ${jinglerHome ? `<key>EnvironmentVariables</key><dict><key>JINGLER_HOME</key><string>${xml(jinglerHome)}</string></dict>` : ""}
</dict>
</plist>
`

const systemdQuote = (value: string): string =>
  `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("%", "%%")}"`

const systemdDefinition = (nodePath: string, agentPath: string, jinglerHome: string | undefined): string => `[Unit]
Description=Jingler remote device agent
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=${systemdQuote(nodePath)} ${systemdQuote(agentPath)} serve
Restart=on-failure
RestartSec=5
${jinglerHome ? `Environment="JINGLER_HOME=${jinglerHome.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("%", "%%")}"` : ""}

[Install]
WantedBy=default.target
`

const requireSuccess = (result: DeviceServiceCommandResult, action: string): void => {
  if (result.exitCode !== 0) {
    throw new Error(`${action} failed${result.stderr.trim() ? `: ${result.stderr.trim()}` : ""}`)
  }
}

export const installDeviceService = async (
  input: InstallDeviceServiceInput = {},
  runner: DeviceServiceCommandRunner = nodeDeviceServiceCommandRunner
): Promise<InstalledDeviceService> => {
  const platform = input.platform ?? process.platform
  const home = input.home ?? homedir()
  const nodePath = input.nodePath ?? process.execPath
  const agentPath = input.agentPath ?? process.argv[1]
  if (!agentPath) throw new Error("Cannot determine the installed device-agent path")
  const stateDir = join(home, ".local", "share", "jingler")
  await mkdir(stateDir, { recursive: true, mode: 0o700 })
  await chmod(stateDir, 0o700)

  if (platform === "darwin") {
    const uid = input.uid ?? process.getuid?.()
    if (uid === undefined) throw new Error("Cannot determine the macOS user id")
    const definitionPath = join(home, "Library", "LaunchAgents", `${LABEL}.plist`)
    await atomicWrite(
      definitionPath,
      launchdDefinition(nodePath, agentPath, join(stateDir, "device-agent.log"), input.jinglerHome)
    )
    const domains = [`gui/${uid}`, `user/${uid}`]
    let installed = false
    let lastError = ""
    for (const domain of domains) {
      await runner.run("launchctl", ["bootout", domain, definitionPath]).catch(() => ({
        exitCode: 1,
        stderr: ""
      }))
      const bootstrap = await runner.run("launchctl", ["bootstrap", domain, definitionPath])
      if (bootstrap.exitCode === 0) {
        requireSuccess(
          await runner.run("launchctl", ["kickstart", "-k", `${domain}/${LABEL}`]),
          "Starting the Jingler device service"
        )
        installed = true
        break
      }
      lastError = bootstrap.stderr
    }
    if (!installed) {
      throw new Error(`Installing the Jingler launch agent failed${lastError.trim() ? `: ${lastError.trim()}` : ""}`)
    }
    return { manager: "launchd", definitionPath }
  }

  if (platform === "linux") {
    const definitionPath = join(home, ".config", "systemd", "user", "jingler-device-agent.service")
    await atomicWrite(definitionPath, systemdDefinition(nodePath, agentPath, input.jinglerHome))
    requireSuccess(await runner.run("systemctl", ["--user", "daemon-reload"]), "Reloading the systemd user manager")
    requireSuccess(
      await runner.run("systemctl", ["--user", "enable", "--now", "jingler-device-agent.service"]),
      "Starting the Jingler device service"
    )
    return { manager: "systemd", definitionPath }
  }

  throw new Error(`Persistent device service installation is not supported on ${platform}`)
}

/** Remove persistence without trying to stop the process currently performing cleanup. */
export const removeDeviceService = async (
  input: RemoveDeviceServiceInput = {},
  runner: DeviceServiceCommandRunner = nodeDeviceServiceCommandRunner
): Promise<void> => {
  const platform = input.platform ?? process.platform
  const home = input.home ?? homedir()
  const stop = input.stop ?? true
  if (platform === "darwin") {
    const definitionPath = join(home, "Library", "LaunchAgents", `${LABEL}.plist`)
    // Remove the durable definition before asking launchd to stop the job. A
    // daemon may be revoking itself, in which case bootout terminates this
    // process before it can perform any later filesystem cleanup.
    await rm(definitionPath, { force: true })
    if (stop) {
      const uid = input.uid ?? process.getuid?.()
      if (uid !== undefined) {
        for (const domain of [`gui/${uid}`, `user/${uid}`]) {
          await runner.run("launchctl", ["bootout", `${domain}/${LABEL}`]).catch(() => ({
            exitCode: 1,
            stderr: ""
          }))
        }
      }
    }
    return
  }
  if (platform === "linux") {
    await runner
      .run("systemctl", ["--user", "disable", ...(stop ? ["--now"] : []), "jingler-device-agent.service"])
      .catch(() => ({
        exitCode: 1,
        stderr: ""
      }))
    await rm(join(home, ".config", "systemd", "user", "jingler-device-agent.service"), {
      force: true
    })
  }
}
