import { mkdtemp, readFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import {
  installDeviceService,
  removeDeviceService,
  type DeviceServiceCommandRunner
} from "./device-service.js"

describe("device service installation", () => {
  it("installs and starts a launchd user agent with exact executable paths", async () => {
    const home = await mkdtemp(join(tmpdir(), "jingler-launchd-"))
    const calls: Array<{ binary: string; args: ReadonlyArray<string> }> = []
    const runner: DeviceServiceCommandRunner = {
      run: async (binary, args) => {
        calls.push({ binary, args })
        return { exitCode: 0, stderr: "" }
      }
    }
    const installed = await installDeviceService(
      {
        platform: "darwin",
        uid: 501,
        home,
        nodePath: "/Users/test/.local/share/jingler/runtime/bin/node",
        agentPath: "/Users/test/.local/share/jingler/jingler-device.mjs"
      },
      runner
    )
    const definition = await readFile(installed.definitionPath, "utf8")
    expect(installed.manager).toBe("launchd")
    expect(definition).toContain("<key>SuccessfulExit</key><false/>")
    expect(definition).toContain("/Users/test/.local/share/jingler/runtime/bin/node")
    expect(calls).toContainEqual({
      binary: "launchctl",
      args: ["bootstrap", "gui/501", installed.definitionPath]
    })
    expect(calls.at(-1)).toStrictEqual({
      binary: "launchctl",
      args: ["kickstart", "-k", "gui/501/app.jingler.device-agent"]
    })
  })

  it("installs and enables a systemd user service with restart-on-failure", async () => {
    const home = await mkdtemp(join(tmpdir(), "jingler-systemd-"))
    const calls: Array<{ binary: string; args: ReadonlyArray<string> }> = []
    const installed = await installDeviceService(
      {
        platform: "linux",
        home,
        nodePath: "/opt/jingler/node",
        agentPath: "/opt/jingler/agent.mjs"
      },
      {
        run: async (binary, args) => {
          calls.push({ binary, args })
          return { exitCode: 0, stderr: "" }
        }
      }
    )
    const definition = await readFile(installed.definitionPath, "utf8")
    expect(definition).toContain("Restart=on-failure")
    expect(definition).toContain('ExecStart="/opt/jingler/node" "/opt/jingler/agent.mjs" serve')
    expect(calls).toStrictEqual([
      { binary: "systemctl", args: ["--user", "daemon-reload"] },
      {
        binary: "systemctl",
        args: ["--user", "enable", "--now", "jingler-device-agent.service"]
      }
    ])
  })

  it("removes the persistent launch definition after server revocation", async () => {
    const home = await mkdtemp(join(tmpdir(), "jingler-service-revoke-"))
    const calls: Array<{ binary: string; args: ReadonlyArray<string> }> = []
    const runner: DeviceServiceCommandRunner = {
      run: async (binary, args) => {
        calls.push({ binary, args })
        return { exitCode: 0, stderr: "" }
      }
    }
    const installed = await installDeviceService(
      {
        platform: "darwin",
        uid: 501,
        home,
        nodePath: "/opt/jingler/node",
        agentPath: "/opt/jingler/agent.mjs"
      },
      runner
    )
    calls.length = 0
    await removeDeviceService({ platform: "darwin", uid: 501, home }, runner)
    await expect(readFile(installed.definitionPath, "utf8")).rejects.toMatchObject({
      code: "ENOENT"
    })
    expect(calls).toStrictEqual([
      {
        binary: "launchctl",
        args: ["bootout", "gui/501/app.jingler.device-agent"]
      },
      {
        binary: "launchctl",
        args: ["bootout", "user/501/app.jingler.device-agent"]
      }
    ])
  })
})
