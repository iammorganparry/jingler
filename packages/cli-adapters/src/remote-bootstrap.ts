import { spawn } from "node:child_process"
import { readFile } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"
import type { PendingDeviceRegistrationResponse } from "@jingler/core"
import { PendingDeviceRegistrationResponse as PendingDeviceRegistrationResponseSchema } from "@jingler/core"
import { Data, Effect, Schema } from "effect"

export interface SshHostSuggestion {
  readonly alias: string
  readonly hostname: string
  readonly username: string | null
  readonly port: number
  readonly source: "config" | "known-hosts"
}

const PUBLIC_SERVICE_HOSTS = new Set([
  "github.com",
  "gitlab.com",
  "bitbucket.org",
  "ssh.dev.azure.com"
])
const CONCRETE_HOST = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,252}$/u
const SSH_USER = /^[A-Za-z_][A-Za-z0-9._-]{0,63}$/u

const usableHost = (host: string): boolean =>
  CONCRETE_HOST.test(host) &&
  !host.includes("*") &&
  !host.includes("?") &&
  !host.includes("!") &&
  !PUBLIC_SERVICE_HOSTS.has(host.toLocaleLowerCase("en-US"))

interface ConfigHost {
  aliases: Array<string>
  hostname: string | null
  username: string | null
  port: number
}

const configHosts = (source: string): ReadonlyArray<SshHostSuggestion> => {
  const blocks: Array<ConfigHost> = []
  let current: ConfigHost | null = null
  for (const rawLine of source.split(/\r?\n/u)) {
    const line = rawLine.replace(/\s+#.*$/u, "").trim()
    if (!line || line.startsWith("#")) continue
    const separator = line.search(/[\s=]/u)
    const key = (separator < 0 ? line : line.slice(0, separator)).toLocaleLowerCase("en-US")
    const value = (separator < 0 ? "" : line.slice(separator + 1)).replace(/^\s*=\s*/u, "").trim()
    if (key === "host") {
      current = { aliases: value.split(/\s+/u), hostname: null, username: null, port: 22 }
      blocks.push(current)
      continue
    }
    if (!current) continue
    if (key === "hostname") current.hostname = value
    if (key === "user") current.username = SSH_USER.test(value) ? value : null
    if (key === "port" && /^\d{1,5}$/u.test(value)) {
      const port = Number(value)
      if (port >= 1 && port <= 65_535) current.port = port
    }
  }
  return blocks.flatMap((block) =>
    block.aliases
      .filter(usableHost)
      .filter(() => block.hostname === null || usableHost(block.hostname))
      .map((alias) => ({
        alias,
        hostname: block.hostname ?? alias,
        username: block.username,
        port: block.port,
        source: "config" as const
      }))
  )
}

const knownHosts = (source: string): ReadonlyArray<SshHostSuggestion> =>
  source.split(/\r?\n/u).flatMap((rawLine) => {
    const line = rawLine.trim()
    if (!line || line.startsWith("#") || line.startsWith("|1|")) return []
    const fields = line.split(/\s+/u)
    const hostField = fields[0]?.startsWith("@") ? fields[1] : fields[0]
    if (!hostField) return []
    return hostField.split(",").flatMap((rawHost) => {
      const bracketed = /^\[([^\]]+)\]:(\d{1,5})$/u.exec(rawHost)
      const hostname = bracketed?.[1] ?? rawHost
      const port = bracketed ? Number(bracketed[2]) : 22
      if (!usableHost(hostname) || port < 1 || port > 65_535) return []
      return [{ alias: hostname, hostname, username: null, port, source: "known-hosts" as const }]
    })
  })

export const parseSshHostSuggestions = (
  sshConfig: string,
  knownHostsSource: string
): ReadonlyArray<SshHostSuggestion> => {
  const found = [...configHosts(sshConfig), ...knownHosts(knownHostsSource)]
  const seen = new Set<string>()
  return found
    .filter((host) => {
      const key = host.alias.toLocaleLowerCase("en-US")
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
    .sort((left, right) => left.alias.localeCompare(right.alias))
}

const readOptional = (path: string): Promise<string> => readFile(path, "utf8").catch(() => "")

export const discoverSshHosts = (
  sshDir = join(homedir(), ".ssh")
): Effect.Effect<ReadonlyArray<SshHostSuggestion>, never> =>
  Effect.promise(async () =>
    parseSshHostSuggestions(
      await readOptional(join(sshDir, "config")),
      await readOptional(join(sshDir, "known_hosts"))
    )
  )

export class SshBootstrapError extends Data.TaggedError("SshBootstrapError")<{
  readonly kind: "invalid-host" | "authentication" | "incompatible" | "connection" | "invalid-response"
  readonly message: string
  readonly cause?: unknown
}> {}

export interface BootstrapSshInput {
  readonly host: string
  readonly username?: string
  readonly port?: number
  readonly sshBinary?: string
  readonly relayUrl?: string
}

export interface InstallAndBootstrapSshInput extends BootstrapSshInput {
  readonly agentBundlePath: string
  readonly scpBinary?: string
}

export interface SpawnResult {
  readonly exitCode: number
  readonly stdout: string
  readonly stderr: string
}

export interface SshProcessRunner {
  readonly run: (
    binary: string,
    args: ReadonlyArray<string>,
    options: { readonly shell: false }
  ) => Promise<SpawnResult>
}

export const nodeSshProcessRunner: SshProcessRunner = {
  run: (binary, args, options) =>
    new Promise((resolve, reject) => {
      const child = spawn(binary, [...args], {
        shell: options.shell,
        stdio: ["ignore", "pipe", "pipe"]
      })
      let stdout = ""
      let stderr = ""
      child.stdout.setEncoding("utf8")
      child.stderr.setEncoding("utf8")
      child.stdout.on("data", (chunk: string) => {
        stdout += chunk
      })
      child.stderr.on("data", (chunk: string) => {
        stderr += chunk
      })
      child.once("error", reject)
      child.once("close", (exitCode) => resolve({ exitCode: exitCode ?? 255, stdout, stderr }))
    })
}

const pairingResponse = (stdout: string): PendingDeviceRegistrationResponse => {
  const lines = stdout.split(/\r?\n/u).map((line) => line.trim()).filter(Boolean)
  const candidate = lines.at(-1)
  if (!candidate) {
    throw new SshBootstrapError({ kind: "invalid-response", message: "Device agent returned no pairing result" })
  }
  try {
    return Schema.decodeUnknownSync(PendingDeviceRegistrationResponseSchema)(JSON.parse(candidate), {
      onExcessProperty: "error"
    })
  } catch (cause) {
    throw new SshBootstrapError({ kind: "invalid-response", message: "Device agent returned an invalid pairing result", cause })
  }
}

const checkedRelayUrl = (value: string | undefined): string | null => {
  if (value === undefined) return null
  try {
    const url = new URL(value)
    if (
      !(url.protocol === "https:" || url.protocol === "http:") ||
      url.username ||
      url.password ||
      url.hash
    ) {
      return null
    }
    return url.toString()
  } catch {
    return null
  }
}

const quoteRemoteArgument = (value: string): string => `'${value.replaceAll("'", `'"'"'`)}'`

const pairingCommand = (relayUrl: string | undefined): string => {
  if (relayUrl === undefined) return "jingler-device pair --json"
  const checked = checkedRelayUrl(relayUrl)
  if (!checked) {
    throw new SshBootstrapError({ kind: "invalid-host", message: "Device relay URL is invalid" })
  }
  return `jingler-device pair --json --relay ${quoteRemoteArgument(checked)}`
}

const executeBootstrap = (
  input: BootstrapSshInput,
  remoteAgentCommand: string,
  runner: SshProcessRunner = nodeSshProcessRunner
): Effect.Effect<PendingDeviceRegistrationResponse, SshBootstrapError> =>
  Effect.tryPromise({
    try: async () => {
      if (!usableHost(input.host)) {
        throw new SshBootstrapError({ kind: "invalid-host", message: "SSH host or alias is invalid" })
      }
      if (input.username !== undefined && !SSH_USER.test(input.username)) {
        throw new SshBootstrapError({ kind: "invalid-host", message: "SSH username is invalid" })
      }
      const port = input.port ?? 22
      if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
        throw new SshBootstrapError({ kind: "invalid-host", message: "SSH port is invalid" })
      }
      const destination = input.username ? `${input.username}@${input.host}` : input.host
      const result = await runner.run(
        input.sshBinary ?? "ssh",
        [
          "-o",
          "BatchMode=yes",
          "-o",
          "ConnectTimeout=10",
          "-p",
          String(port),
          destination,
          remoteAgentCommand
        ],
        { shell: false }
      )
      if (result.exitCode !== 0) {
        const authentication = /permission denied|authentication failed|publickey/iu.test(result.stderr)
        const incompatible = /not found|protocol|unsupported|incompatible/iu.test(result.stderr)
        throw new SshBootstrapError({
          kind: authentication ? "authentication" : incompatible ? "incompatible" : "connection",
          message: authentication
            ? "SSH authentication failed"
            : incompatible
              ? "The remote Jingler device agent is missing or incompatible"
              : "Could not start the remote Jingler device agent"
        })
      }
      return pairingResponse(result.stdout)
    },
    catch: (cause) =>
      cause instanceof SshBootstrapError
        ? cause
        : new SshBootstrapError({ kind: "connection", message: "SSH bootstrap failed", cause })
  })

export const bootstrapRemoteDevice = (
  input: BootstrapSshInput,
  runner: SshProcessRunner = nodeSshProcessRunner
): Effect.Effect<PendingDeviceRegistrationResponse, SshBootstrapError> =>
  Effect.suspend(() => executeBootstrap(input, pairingCommand(input.relayUrl), runner))

const INSTALLED_AGENT = '"$HOME/.local/share/jingler/jingler-device.mjs"'
const INSTALL_AGENT =
  'mkdir -p "$HOME/.local/share/jingler" && install -m 700 .jingler-device-upload.mjs ' +
  INSTALLED_AGENT

/** Upload the shipped standalone bundle, install it idempotently, then pair it. */
export const installAndBootstrapRemoteDevice = (
  input: InstallAndBootstrapSshInput,
  runner: SshProcessRunner = nodeSshProcessRunner
): Effect.Effect<PendingDeviceRegistrationResponse, SshBootstrapError> =>
  Effect.gen(function* () {
    if (!usableHost(input.host)) {
      return yield* Effect.fail(
        new SshBootstrapError({ kind: "invalid-host", message: "SSH host or alias is invalid" })
      )
    }
    if (input.username !== undefined && !SSH_USER.test(input.username)) {
      return yield* Effect.fail(
        new SshBootstrapError({ kind: "invalid-host", message: "SSH username is invalid" })
      )
    }
    const port = input.port ?? 22
    if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
      return yield* Effect.fail(
        new SshBootstrapError({ kind: "invalid-host", message: "SSH port is invalid" })
      )
    }
    const destination = input.username ? `${input.username}@${input.host}` : input.host
    const upload = yield* Effect.tryPromise({
      try: () =>
        runner.run(
          input.scpBinary ?? "scp",
          [
            "-o",
            "BatchMode=yes",
            "-o",
            "ConnectTimeout=10",
            "-P",
            String(port),
            input.agentBundlePath,
            `${destination}:.jingler-device-upload.mjs`
          ],
          { shell: false }
        ),
      catch: (cause) =>
        new SshBootstrapError({ kind: "connection", message: "Device agent upload failed", cause })
    })
    if (upload.exitCode !== 0) {
      return yield* Effect.fail(
        new SshBootstrapError({
          kind: /permission denied|publickey/iu.test(upload.stderr)
            ? "authentication"
            : "connection",
          message: "Device agent upload failed"
        })
      )
    }
    const relay = checkedRelayUrl(input.relayUrl)
    if (!relay) {
      return yield* Effect.fail(
        new SshBootstrapError({ kind: "invalid-host", message: "Device relay URL is required" })
      )
    }
    return yield* executeBootstrap(
      {
        host: input.host,
        ...(input.username === undefined ? {} : { username: input.username }),
        port,
        ...(input.sshBinary === undefined ? {} : { sshBinary: input.sshBinary })
      },
      `${INSTALL_AGENT} && node ${INSTALLED_AGENT} pair --json --relay ${quoteRemoteArgument(relay)}`,
      runner
    )
  })

export class RemoteBootstrapService extends Effect.Service<RemoteBootstrapService>()(
  "@jingler/RemoteBootstrapService",
  {
    accessors: true,
    sync: () => ({
      discoverHosts: discoverSshHosts,
      bootstrap: bootstrapRemoteDevice,
      installAndBootstrap: installAndBootstrapRemoteDevice
    })
  }
) {}
