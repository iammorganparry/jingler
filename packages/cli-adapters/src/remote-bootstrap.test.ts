import { spawnSync } from "node:child_process"
import {
  mkdirSync,
  mkdtempSync,
  readlinkSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, Exit } from "effect"
import { describe, expect, it } from "vitest"
import {
  activateRemoteDevice,
  bootstrapRemoteDevice,
  installAndEnrollOwnedDevice,
  installAndBootstrapRemoteDevice,
  parseSshHostSuggestions,
  type SpawnResult,
  type SshProcessRunner
} from "./remote-bootstrap.js"

const pairing = {
  version: 1,
  pendingDeviceId: "pending_test",
  deviceId: "device_test",
  pairingCode: "ABCDEFGH",
  expiresAt: 2_000_000_000
} as const

const enrollmentCredential = {
  version: 1,
  claim: {
    version: 1,
    claimId: "claim_test",
    subject: "user_test",
    deviceId: "device_test",
    clientInstanceId: "desktop_test",
    audience: "device-claim",
    issuedAt: 1_000,
    expiresAt: 2_000
  },
  token: "opaque.enrollment.token"
} as const

const runner = (result: SpawnResult, calls: Array<unknown>): SshProcessRunner => ({
  run: async (binary, args, options) => {
    calls.push({ binary, args, options })
    return result
  }
})

describe("remote agent installation", () => {
  it("delivers the enrollment credential over SSH stdin without exposing it in argv", async () => {
    const calls: Array<unknown> = []
    const results: Array<SpawnResult> = [
      { exitCode: 0, stdout: "", stderr: "" },
      {
        exitCode: 0,
        stdout: `${JSON.stringify({ version: 1, deviceId: "device_test", displayName: "Build machine" })}\n`,
        stderr: ""
      }
    ]
    const result = await Effect.runPromise(
      installAndEnrollOwnedDevice(
        {
          host: "buildbox",
          serverUrl: "https://api.example.test",
          credential: enrollmentCredential,
          displayName: "Build machine",
          agentBundlePath: "/Applications/Jingler/device-agent/jingler-device-runtime.tgz"
        },
        {
          run: async (binary, args, options) => {
            calls.push({ binary, args, options })
            return results.shift() ?? { exitCode: 1, stdout: "", stderr: "unexpected" }
          }
        }
      )
    )

    expect(result.deviceId).toBe("device_test")
    const sshCall = calls[1] as {
      readonly args: ReadonlyArray<string>
      readonly options: { readonly stdin?: string }
    }
    expect(sshCall.args.join(" ")).toContain("enroll")
    expect(sshCall.args.join(" ")).toContain("--install-service")
    expect(sshCall.args.join(" ")).not.toContain(enrollmentCredential.token)
    expect(sshCall.options.stdin).toBe(`${JSON.stringify(enrollmentCredential)}\n`)
  })

  it("reports enrollment failures without credential material", async () => {
    const result = Effect.runPromiseExit(
      installAndEnrollOwnedDevice(
        {
          host: "buildbox",
          serverUrl: "https://api.example.test",
          credential: enrollmentCredential,
          agentBundlePath: "/Applications/Jingler/device-agent/jingler-device-runtime.tgz"
        },
        {
          run: async (binary) =>
            binary === "scp"
              ? { exitCode: 0, stdout: "", stderr: "" }
              : { exitCode: 1, stdout: "", stderr: "Device enrollment credential expired" }
        }
      )
    )

    const exit = await result
    expect(Exit.isFailure(exit) && exit.cause.toString()).toContain("enrollment exchange failed")
    expect(Exit.isFailure(exit) && exit.cause.toString()).not.toContain(enrollmentCredential.token)
  })

  it("uploads and installs the shipped bundle before pairing", async () => {
    const calls: Array<unknown> = []
    const results: Array<SpawnResult> = [
      { exitCode: 0, stdout: "", stderr: "" },
      { exitCode: 0, stdout: `${JSON.stringify(pairing)}\n`, stderr: "" }
    ]
    const processRunner: SshProcessRunner = {
      run: async (binary, args, options) => {
        calls.push({ binary, args, options })
        return (
          results.shift() ?? {
            exitCode: 1,
            stdout: "",
            stderr: "unexpected call"
          }
        )
      }
    }
    const result = await Effect.runPromise(
      installAndBootstrapRemoteDevice(
        {
          host: "buildbox",
          username: "morgan",
          relayUrl: "https://relay.example.test",
          agentBundlePath: "/Applications/Jingler/device-agent/jingler-device-runtime.tgz"
        },
        processRunner
      )
    )
    expect(result).toStrictEqual(pairing)
    expect(calls).toHaveLength(2)
    expect(calls[0]).toMatchObject({
      binary: "scp",
      args: expect.arrayContaining([
        expect.stringContaining("jingler-device-runtime.tgz"),
        expect.stringContaining(".jingler-device-runtime-upload.tgz")
      ]),
      options: { shell: false }
    })
    expect(calls[0]).toMatchObject({ args: expect.not.arrayContaining(["-P"]) })
    expect(calls[1]).toMatchObject({
      binary: "ssh",
      options: { shell: false }
    })
    expect(calls[1]).toMatchObject({
      args: expect.arrayContaining([expect.stringContaining('"${SHELL:-/bin/sh}" -lic')])
    })
    expect(calls[1]).toMatchObject({
      args: expect.arrayContaining([
        expect.stringMatching(/nodejs\.org\/dist\/v22\.22\.0[\s\S]*runtime\/bin\/node/u)
      ])
    })
    const remoteCommand = (calls[1] as { args: ReadonlyArray<string> }).args.at(-1)
    expect(remoteCommand).toContain("managed-runtime/current")
    expect(remoteCommand).toContain("node_modules/pi-subagents/index.ts")
    expect(spawnSync("sh", ["-n", "-c", remoteCommand ?? ""]).status).toBe(0)
  })

  it("recovers from an interrupted switch and prunes superseded releases", async () => {
    const calls: Array<unknown> = []
    await Effect.runPromise(
      installAndBootstrapRemoteDevice(
        {
          host: "buildbox",
          relayUrl: "https://relay.example.test",
          agentBundlePath: "/Applications/Jingler/device-agent/jingler-device-runtime.tgz"
        },
        runner({ exitCode: 0, stdout: `${JSON.stringify(pairing)}\n`, stderr: "" }, calls)
      )
    )
    const remoteCommand = (calls[1] as { args: ReadonlyArray<string> }).args.at(-1) ?? ""
    const loginShellMarker = ` && "\${SHELL:-/bin/sh}" -lic`
    const loginShellIndex = remoteCommand.indexOf(loginShellMarker)
    expect(loginShellIndex).toBeGreaterThan(0)
    const installCommand = remoteCommand.slice(0, loginShellIndex)
    const home = mkdtempSync(join(tmpdir(), "jingler-remote-install-"))
    const managedRoot = join(home, ".local/share/jingler/managed-runtime")
    const releases = join(managedRoot, "releases")

    const createUpload = (): void => {
      const bundle = join(home, "bundle")
      rmSync(bundle, { recursive: true, force: true })
      mkdirSync(join(bundle, "node_modules/pi-subagents"), { recursive: true })
      writeFileSync(join(bundle, "jingler-device.mjs"), "export {}\n")
      writeFileSync(join(bundle, "node_modules/pi-subagents/index.ts"), "export {}\n")
      expect(
        spawnSync("tar", ["-czf", ".jingler-device-runtime-upload.tgz", "-C", bundle, "."], {
          cwd: home
        }).status
      ).toBe(0)
    }

    try {
      mkdirSync(join(releases, "runtime-old"), { recursive: true })
      symlinkSync(join(releases, "runtime-old"), join(managedRoot, "current.next"))
      createUpload()
      expect(spawnSync("sh", ["-c", installCommand], { cwd: home, env: { ...process.env, HOME: home } }).status).toBe(0)

      const firstRelease = readlinkSync(join(managedRoot, "current"))
      expect(readdirSync(releases)).toStrictEqual([firstRelease.split("/").at(-1)])

      createUpload()
      expect(spawnSync("sh", ["-c", installCommand], { cwd: home, env: { ...process.env, HOME: home } }).status).toBe(0)

      const secondRelease = readlinkSync(join(managedRoot, "current"))
      expect(secondRelease).not.toBe(firstRelease)
      expect(readdirSync(releases)).toStrictEqual([secondRelease.split("/").at(-1)])
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  it("activates the claimed daemon through the remote login shell", async () => {
    const calls: Array<unknown> = []
    await Effect.runPromise(
      activateRemoteDevice(
        {
          host: "mac",
          username: "builder",
          subject: "user-one",
          deviceId: "device-one",
          serverUrl: "https://api.jingler.dev"
        },
        runner({ exitCode: 0, stdout: "", stderr: "" }, calls)
      )
    )
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({
      binary: "ssh",
      args: expect.arrayContaining([
        "builder@mac",
        expect.stringMatching(/install-service.*--subject.*user-one.*--device-id.*device-one/u)
      ]),
      options: { shell: false }
    })
    expect(calls[0]).toMatchObject({ args: expect.not.arrayContaining(["-p"]) })
  })

  it("explains passwordless SSH requirements when upload or activation authentication fails", async () => {
    const denied = { exitCode: 255, stdout: "", stderr: "Permission denied (publickey)." }
    const upload = await Effect.runPromiseExit(
      installAndBootstrapRemoteDevice(
        {
          host: "buildbox",
          relayUrl: "https://relay.example.test",
          agentBundlePath: "/Applications/Jingler/device-agent/jingler-device-runtime.tgz"
        },
        runner(denied, [])
      )
    )
    const activation = await Effect.runPromiseExit(
      activateRemoteDevice(
        {
          host: "buildbox",
          subject: "user-one",
          deviceId: "device-one",
          serverUrl: "https://api.jingler.dev"
        },
        runner(denied, [])
      )
    )
    expect(Exit.isFailure(upload) && upload.cause.toString()).toContain(
      "ssh buildbox works without a password"
    )
    expect(Exit.isFailure(upload) && upload.cause.toString()).toContain(
      "User and IdentityFile"
    )
    expect(Exit.isFailure(activation) && activation.cause.toString()).toContain(
      "ssh buildbox works without a password"
    )
    expect(Exit.isFailure(activation) && activation.cause.toString()).toContain(
      "User and IdentityFile"
    )
  })

  it("explains when the local device-agent bundle is missing", async () => {
    const upload = await Effect.runPromiseExit(
      installAndBootstrapRemoteDevice(
        {
          host: "buildbox",
          relayUrl: "https://relay.example.test",
          agentBundlePath: "/repo/apps/device-agent/dist/jingler-device-runtime.tgz"
        },
        runner(
          {
            exitCode: 1,
            stdout: "",
            stderr:
              'scp: stat local "/repo/apps/device-agent/dist/jingler-device-runtime.tgz": No such file or directory\n'
          },
          []
        )
      )
    )

    expect(Exit.isFailure(upload) && upload.cause.toString()).toContain(
      "The bundled device agent is missing"
    )
    expect(Exit.isFailure(upload) && upload.cause.toString()).toContain(
      "rebuild and restart Jingler"
    )
  })
})

describe("remote bootstrap", () => {
  it("discovers concrete aliases from SSH config and known hosts", () => {
    const result = parseSshHostSuggestions(
      "Host buildbox\n  User morgan\n  Port 2222\nHost mac\n  HostName 192.168.1.12\n",
      "edgebox ssh-ed25519 AAAA\n[staging.local]:2200 ssh-ed25519 BBBB\n"
    )
    expect(result.map((host) => host.alias)).toStrictEqual(["buildbox", "edgebox", "mac", "staging.local"])
    expect(result.find((host) => host.alias === "buildbox")).toMatchObject({
      username: "morgan",
      port: 2222
    })
  })

  it("excludes wildcard aliases and github.com", () => {
    const result = parseSshHostSuggestions(
      "Host *\nHost *.internal\nHost github.com\nHost github.com-mipstudios\n  HostName github.com\nHost buildbox\n",
      "github.com ssh-ed25519 AAAA\n|1|hashed|entry ssh-ed25519 BBBB\n"
    )
    expect(result.map((host) => host.alias)).toStrictEqual(["buildbox"])
  })

  it("deduplicates aliases across SSH sources", () => {
    const result = parseSshHostSuggestions(
      "Host buildbox\n  User morgan\n",
      "buildbox ssh-ed25519 AAAA\nBUILDBOX ssh-ed25519 BBBB\n"
    )
    expect(result).toHaveLength(1)
    expect(result[0]?.source).toBe("config")
  })

  it("invokes SSH with explicit argv and BatchMode", async () => {
    const calls: Array<unknown> = []
    const result = await Effect.runPromise(
      bootstrapRemoteDevice(
        { host: "buildbox", username: "morgan", port: 2222 },
        runner({ exitCode: 0, stdout: `${JSON.stringify(pairing)}\n`, stderr: "" }, calls)
      )
    )
    expect(result.deviceId).toBe(pairing.deviceId)
    expect(calls).toStrictEqual([
      {
        binary: "ssh",
        args: [
          "-o",
          "BatchMode=yes",
          "-o",
          "ConnectTimeout=10",
          "-p",
          "2222",
          "morgan@buildbox",
          "jingler-device pair --json"
        ],
        options: { shell: false }
      }
    ])
  })

  it("passes configured aliases through without overriding SSH user or port", async () => {
    const calls: Array<unknown> = []
    await Effect.runPromise(
      bootstrapRemoteDevice(
        { host: "mac" },
        runner({ exitCode: 0, stdout: `${JSON.stringify(pairing)}\n`, stderr: "" }, calls)
      )
    )
    expect(calls).toStrictEqual([
      {
        binary: "ssh",
        args: [
          "-o",
          "BatchMode=yes",
          "-o",
          "ConnectTimeout=10",
          "mac",
          "jingler-device pair --json"
        ],
        options: { shell: false }
      }
    ])
  })

  it("does not interpolate hostile host input into a shell", async () => {
    const calls: Array<unknown> = []
    const exit = await Effect.runPromiseExit(
      bootstrapRemoteDevice(
        { host: "buildbox; touch /tmp/owned" },
        runner({ exitCode: 0, stdout: `${JSON.stringify(pairing)}\n`, stderr: "" }, calls)
      )
    )
    expect(Exit.isFailure(exit)).toBe(true)
    expect(calls).toStrictEqual([])
  })

  it("maps SSH authentication and compatibility failures", async () => {
    const auth = await Effect.runPromiseExit(
      bootstrapRemoteDevice(
        { host: "buildbox" },
        runner(
          {
            exitCode: 255,
            stdout: "",
            stderr: "Permission denied (publickey)."
          },
          []
        )
      )
    )
    const incompatible = await Effect.runPromiseExit(
      bootstrapRemoteDevice(
        { host: "buildbox" },
        runner(
          {
            exitCode: 127,
            stdout: "",
            stderr: "jingler-device: command not found"
          },
          []
        )
      )
    )
    expect(Exit.isFailure(auth) && auth.cause.toString()).toContain("authentication")
    expect(Exit.isFailure(auth) && auth.cause.toString()).toContain(
      "ssh buildbox works without a password"
    )
    expect(Exit.isFailure(incompatible) && incompatible.cause.toString()).toContain("incompatible")
  })

  it("returns the device pairing result from a successful bootstrap", async () => {
    const result = await Effect.runPromise(
      bootstrapRemoteDevice(
        { host: "buildbox" },
        runner(
          {
            exitCode: 0,
            stdout: `starting agent\n${JSON.stringify(pairing)}\n`,
            stderr: ""
          },
          []
        )
      )
    )
    expect(result).toStrictEqual(pairing)
  })
})
