import { Effect, Exit } from "effect"
import { describe, expect, it } from "vitest"
import {
  bootstrapRemoteDevice,
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

const runner = (result: SpawnResult, calls: Array<unknown>): SshProcessRunner => ({
  run: async (binary, args, options) => {
    calls.push({ binary, args, options })
    return result
  }
})

describe("remote agent installation", () => {
  it("uploads and installs the shipped bundle before pairing", async () => {
    const calls: Array<unknown> = []
    const results: Array<SpawnResult> = [
      { exitCode: 0, stdout: "", stderr: "" },
      { exitCode: 0, stdout: `${JSON.stringify(pairing)}\n`, stderr: "" }
    ]
    const processRunner: SshProcessRunner = {
      run: async (binary, args, options) => {
        calls.push({ binary, args, options })
        return results.shift() ?? { exitCode: 1, stdout: "", stderr: "unexpected call" }
      }
    }
    const result = await Effect.runPromise(
      installAndBootstrapRemoteDevice(
        {
          host: "clive.local",
          username: "morgan",
          relayUrl: "https://relay.example.test",
          agentBundlePath: "/Applications/Jingler/device-agent/jingler-device.mjs"
        },
        processRunner
      )
    )
    expect(result).toStrictEqual(pairing)
    expect(calls).toHaveLength(2)
    expect(calls[0]).toMatchObject({ binary: "scp", options: { shell: false } })
    expect(calls[1]).toMatchObject({ binary: "ssh", options: { shell: false } })
  })
})

describe("remote bootstrap", () => {
  it("discovers concrete aliases from SSH config and known hosts", () => {
    const result = parseSshHostSuggestions(
      "Host clive.local\n  User morgan\n  Port 2222\nHost mac\n  HostName 192.168.1.12\n",
      "buildbox ssh-ed25519 AAAA\n[staging.local]:2200 ssh-ed25519 BBBB\n"
    )
    expect(result.map((host) => host.alias)).toStrictEqual([
      "buildbox",
      "clive.local",
      "mac",
      "staging.local"
    ])
    expect(result.find((host) => host.alias === "clive.local")).toMatchObject({
      username: "morgan",
      port: 2222
    })
  })

  it("excludes wildcard aliases and github.com", () => {
    const result = parseSshHostSuggestions(
      "Host *\nHost *.internal\nHost github.com\nHost github.com-mipstudios\n  HostName github.com\nHost clive.local\n",
      "github.com ssh-ed25519 AAAA\n|1|hashed|entry ssh-ed25519 BBBB\n"
    )
    expect(result.map((host) => host.alias)).toStrictEqual(["clive.local"])
  })

  it("deduplicates aliases across SSH sources", () => {
    const result = parseSshHostSuggestions(
      "Host clive.local\n  User morgan\n",
      "clive.local ssh-ed25519 AAAA\nCLIVE.LOCAL ssh-ed25519 BBBB\n"
    )
    expect(result).toHaveLength(1)
    expect(result[0]?.source).toBe("config")
  })

  it("invokes SSH with explicit argv and BatchMode", async () => {
    const calls: Array<unknown> = []
    const result = await Effect.runPromise(
      bootstrapRemoteDevice(
        { host: "clive.local", username: "morgan", port: 2222 },
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
          "morgan@clive.local",
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
        { host: "clive.local; touch /tmp/owned" },
        runner({ exitCode: 0, stdout: `${JSON.stringify(pairing)}\n`, stderr: "" }, calls)
      )
    )
    expect(Exit.isFailure(exit)).toBe(true)
    expect(calls).toStrictEqual([])
  })

  it("maps SSH authentication and compatibility failures", async () => {
    const auth = await Effect.runPromiseExit(
      bootstrapRemoteDevice(
        { host: "clive.local" },
        runner({ exitCode: 255, stdout: "", stderr: "Permission denied (publickey)." }, [])
      )
    )
    const incompatible = await Effect.runPromiseExit(
      bootstrapRemoteDevice(
        { host: "clive.local" },
        runner({ exitCode: 127, stdout: "", stderr: "jingler-device: command not found" }, [])
      )
    )
    expect(Exit.isFailure(auth) && auth.cause.toString()).toContain("authentication")
    expect(Exit.isFailure(incompatible) && incompatible.cause.toString()).toContain("incompatible")
  })

  it("returns the device pairing result from a successful bootstrap", async () => {
    const result = await Effect.runPromise(
      bootstrapRemoteDevice(
        { host: "clive.local" },
        runner(
          { exitCode: 0, stdout: `starting agent\n${JSON.stringify(pairing)}\n`, stderr: "" },
          []
        )
      )
    )
    expect(result).toStrictEqual(pairing)
  })
})
