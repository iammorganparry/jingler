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

const PUBLIC_SERVICE_HOSTS = new Set(["github.com", "gitlab.com", "bitbucket.org", "ssh.dev.azure.com"])
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
      current = {
        aliases: value.split(/\s+/u),
        hostname: null,
        username: null,
        port: 22
      }
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
      return [
        {
          alias: hostname,
          hostname,
          username: null,
          port,
          source: "known-hosts" as const
        }
      ]
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
  sshDir = process.env.JINGLER_SSH_DIR ?? join(homedir(), ".ssh")
): Effect.Effect<ReadonlyArray<SshHostSuggestion>, never> =>
  Effect.promise(async () =>
    parseSshHostSuggestions(await readOptional(join(sshDir, "config")), await readOptional(join(sshDir, "known_hosts")))
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

export interface ActivateRemoteDeviceInput extends BootstrapSshInput {
  readonly subject: string
  readonly deviceId: string
  readonly serverUrl: string
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
  const lines = stdout
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean)
  const candidate = lines.at(-1)
  if (!candidate) {
    throw new SshBootstrapError({
      kind: "invalid-response",
      message: "Device agent returned no pairing result"
    })
  }
  try {
    return Schema.decodeUnknownSync(PendingDeviceRegistrationResponseSchema)(JSON.parse(candidate), {
      onExcessProperty: "error"
    })
  } catch (cause) {
    throw new SshBootstrapError({
      kind: "invalid-response",
      message: "Device agent returned an invalid pairing result",
      cause
    })
  }
}

const checkedRelayUrl = (value: string | undefined): string | null => {
  if (value === undefined) return null
  try {
    const url = new URL(value)
    if (!(url.protocol === "https:" || url.protocol === "http:") || url.username || url.password || url.hash) {
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
    throw new SshBootstrapError({
      kind: "invalid-host",
      message: "Device relay URL is invalid"
    })
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
        throw new SshBootstrapError({
          kind: "invalid-host",
          message: "SSH host or alias is invalid"
        })
      }
      if (input.username !== undefined && !SSH_USER.test(input.username)) {
        throw new SshBootstrapError({
          kind: "invalid-host",
          message: "SSH username is invalid"
        })
      }
      const port = input.port ?? 22
      if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
        throw new SshBootstrapError({
          kind: "invalid-host",
          message: "SSH port is invalid"
        })
      }
      const destination = input.username ? `${input.username}@${input.host}` : input.host
      const result = await runner.run(
        input.sshBinary ?? "ssh",
        ["-o", "BatchMode=yes", "-o", "ConnectTimeout=10", "-p", String(port), destination, remoteAgentCommand],
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
        : new SshBootstrapError({
            kind: "connection",
            message: "SSH bootstrap failed",
            cause
          })
  })

export const bootstrapRemoteDevice = (
  input: BootstrapSshInput,
  runner: SshProcessRunner = nodeSshProcessRunner
): Effect.Effect<PendingDeviceRegistrationResponse, SshBootstrapError> =>
  Effect.suspend(() => executeBootstrap(input, pairingCommand(input.relayUrl), runner))

const INSTALLED_AGENT = '"$HOME/.local/share/jingler/jingler-device.mjs"'
const INSTALLED_NODE = '"$HOME/.local/share/jingler/runtime/bin/node"'
const INSTALL_AGENT =
  'mkdir -p "$HOME/.local/share/jingler" && install -m 700 .jingler-device-upload.mjs ' + INSTALLED_AGENT
const INSTALL_RUNTIME = [
  'runtime_root="$HOME/.local/share/jingler/runtime"',
  'node_bin="$runtime_root/bin/node"',
  'if [ ! -x "$node_bin" ]; then',
  "if command -v node >/dev/null 2>&1 && node -e 'process.exit(Number(process.versions.node.split(\".\")[0]) >= 22 ? 0 : 1)'; then",
  'mkdir -p "$runtime_root/bin" && ln -sf "$(command -v node)" "$node_bin"',
  "else",
  'platform="$(uname -s)-$(uname -m)"',
  'case "$platform" in',
  'Darwin-arm64) artifact="node-v22.22.0-darwin-arm64.tar.gz"; expected="5ed4db0fcf1eaf84d91ad12462631d73bf4576c1377e192d222e48026a902640" ;;',
  'Darwin-x86_64) artifact="node-v22.22.0-darwin-x64.tar.gz"; expected="5ea50c9d6dea3dfa3abb66b2656f7a4e1c8cef23432b558d45fb538c7b5dedce" ;;',
  'Linux-aarch64|Linux-arm64) artifact="node-v22.22.0-linux-arm64.tar.gz"; expected="25ba95dfb96871fa2ef977f11f95ea90818c8fa15c0f2110771db08d4ba423be" ;;',
  'Linux-x86_64) artifact="node-v22.22.0-linux-x64.tar.gz"; expected="c33c39ed9c80deddde77c960d00119918b9e352426fd604ba41638d6526a4744" ;;',
  '*) echo "Unsupported remote platform: $platform" >&2; exit 69 ;;',
  "esac",
  'archive="$HOME/.local/share/jingler/$artifact"',
  'url="https://nodejs.org/dist/v22.22.0/$artifact"',
  'if command -v curl >/dev/null 2>&1; then curl --fail --location --proto "=https" --tlsv1.2 "$url" --output "$archive";',
  'elif command -v wget >/dev/null 2>&1; then wget --https-only "$url" --output-document "$archive";',
  'else echo "Installing the Jingler runtime requires curl or wget" >&2; exit 69; fi',
  'if command -v shasum >/dev/null 2>&1; then actual="$(shasum -a 256 "$archive" | awk \'{print $1}\')";',
  'elif command -v sha256sum >/dev/null 2>&1; then actual="$(sha256sum "$archive" | awk \'{print $1}\')";',
  'else echo "Installing the Jingler runtime requires shasum or sha256sum" >&2; exit 69; fi',
  'if [ "$actual" != "$expected" ]; then rm -f "$archive"; echo "Jingler runtime checksum mismatch" >&2; exit 70; fi',
  'rm -rf "$runtime_root" && mkdir -p "$runtime_root"',
  'tar -xzf "$archive" -C "$runtime_root" --strip-components=1 && rm -f "$archive"',
  "fi",
  "fi"
].join("\n")

const loginShellCommand = (command: string): string => `"\${SHELL:-/bin/sh}" -lic ${quoteRemoteArgument(command)}`

const installedAgentCommand = (arguments_: string): string => `exec ${INSTALLED_NODE} ${INSTALLED_AGENT} ${arguments_}`

/** Upload the shipped standalone bundle, install it idempotently, then pair it. */
export const installAndBootstrapRemoteDevice = (
  input: InstallAndBootstrapSshInput,
  runner: SshProcessRunner = nodeSshProcessRunner
): Effect.Effect<PendingDeviceRegistrationResponse, SshBootstrapError> =>
  Effect.gen(function* () {
    if (!usableHost(input.host)) {
      return yield* Effect.fail(
        new SshBootstrapError({
          kind: "invalid-host",
          message: "SSH host or alias is invalid"
        })
      )
    }
    if (input.username !== undefined && !SSH_USER.test(input.username)) {
      return yield* Effect.fail(
        new SshBootstrapError({
          kind: "invalid-host",
          message: "SSH username is invalid"
        })
      )
    }
    const port = input.port ?? 22
    if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
      return yield* Effect.fail(
        new SshBootstrapError({
          kind: "invalid-host",
          message: "SSH port is invalid"
        })
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
        new SshBootstrapError({
          kind: "connection",
          message: "Device agent upload failed",
          cause
        })
    })
    if (upload.exitCode !== 0) {
      return yield* Effect.fail(
        new SshBootstrapError({
          kind: /permission denied|publickey/iu.test(upload.stderr) ? "authentication" : "connection",
          message: "Device agent upload failed"
        })
      )
    }
    const relay = checkedRelayUrl(input.relayUrl)
    if (!relay) {
      return yield* Effect.fail(
        new SshBootstrapError({
          kind: "invalid-host",
          message: "Device relay URL is required"
        })
      )
    }
    return yield* executeBootstrap(
      {
        host: input.host,
        ...(input.username === undefined ? {} : { username: input.username }),
        port,
        ...(input.sshBinary === undefined ? {} : { sshBinary: input.sshBinary })
      },
      `${INSTALL_AGENT} && ${loginShellCommand(
        `${INSTALL_RUNTIME} && ${installedAgentCommand(`pair --json --relay ${quoteRemoteArgument(relay)}`)}`
      )}`,
      runner
    )
  })

/** Activate a claimed device and leave its outbound daemon running after SSH exits. */
export const activateRemoteDevice = (
  input: ActivateRemoteDeviceInput,
  runner: SshProcessRunner = nodeSshProcessRunner
): Effect.Effect<void, SshBootstrapError> =>
  Effect.gen(function* () {
    if (!usableHost(input.host)) {
      return yield* Effect.fail(
        new SshBootstrapError({
          kind: "invalid-host",
          message: "SSH host or alias is invalid"
        })
      )
    }
    if (input.username !== undefined && !SSH_USER.test(input.username)) {
      return yield* Effect.fail(
        new SshBootstrapError({
          kind: "invalid-host",
          message: "SSH username is invalid"
        })
      )
    }
    const port = input.port ?? 22
    if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
      return yield* Effect.fail(
        new SshBootstrapError({
          kind: "invalid-host",
          message: "SSH port is invalid"
        })
      )
    }
    const server = checkedRelayUrl(input.serverUrl)
    if (!server) {
      return yield* Effect.fail(
        new SshBootstrapError({
          kind: "invalid-host",
          message: "Jingler server URL is invalid"
        })
      )
    }
    const destination = input.username ? `${input.username}@${input.host}` : input.host
    const serviceArguments = [
      "install-service",
      "--subject",
      quoteRemoteArgument(input.subject),
      "--device-id",
      quoteRemoteArgument(input.deviceId),
      "--server",
      quoteRemoteArgument(server)
    ].join(" ")
    const foreground =
      `if [ -f ${INSTALLED_AGENT} ]; then ${INSTALL_RUNTIME} && ${installedAgentCommand(serviceArguments)}; ` +
      `else exec jingler-device ${serviceArguments}; fi`
    const remoteCommand = 'mkdir -p "$HOME/.local/share/jingler" && ' + loginShellCommand(foreground)
    const result = yield* Effect.tryPromise({
      try: () =>
        runner.run(
          input.sshBinary ?? "ssh",
          ["-o", "BatchMode=yes", "-o", "ConnectTimeout=10", "-p", String(port), destination, remoteCommand],
          { shell: false }
        ),
      catch: (cause) =>
        new SshBootstrapError({
          kind: "connection",
          message: "Device agent activation failed",
          cause
        })
    })
    if (result.exitCode !== 0) {
      return yield* Effect.fail(
        new SshBootstrapError({
          kind: /permission denied|publickey/iu.test(result.stderr) ? "authentication" : "connection",
          message: /permission denied|publickey/iu.test(result.stderr)
            ? "SSH authentication failed"
            : "Could not activate the remote Jingler device agent"
        })
      )
    }
  })

export class RemoteBootstrapService extends Effect.Service<RemoteBootstrapService>()(
  "@jingler/RemoteBootstrapService",
  {
    accessors: true,
    sync: () => ({
      discoverHosts: discoverSshHosts,
      bootstrap: bootstrapRemoteDevice,
      installAndBootstrap: installAndBootstrapRemoteDevice,
      activate: activateRemoteDevice
    })
  }
) {}
