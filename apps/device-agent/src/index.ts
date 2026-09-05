import { readFile } from "node:fs/promises"
import { createConnection } from "node:net"
import { join } from "node:path"
import { registerBunOAuthFlows } from "@earendil-works/pi-ai/bun-oauth"
import { RemoteSessionCommand as RemoteSessionCommandSchema } from "@jingler/core"
import { Schema } from "effect"
import { installDeviceService, removeDeviceService } from "./device-service.js"
import { makeLiveDeviceSessionCommandExecutor } from "./device-executor.js"
import { runManagedCommand } from "./managed-command.js"
import {
  deviceAgentPaths,
  deviceStatus,
  enrollOwnedDevice,
  persistEnrollment,
  revokeLocalDevice,
  rotateLocalDeviceKey,
  serveDevice
} from "./runtime.js"

// pi-ai deliberately keeps OAuth implementations behind bundler-opaque
// imports. The device agent is a standalone bundle, so register the package's
// static loaders before ModelRuntime can resolve a subscription credential.
registerBunOAuthFlows()

// Pin the brokered child-tool extension before any remote session creates an
// embedded parent; process-isolated children inherit this exact packaged path.
process.env.JINGLER_SUBAGENT_CHILD_TOOLS_PATH ??= join(
  import.meta.dirname,
  "runtime-assets",
  "jingler-child-tools.mjs"
)

const args = process.argv.slice(2)
const command = args[0]
const writeProtocolOutput = process.stdout.write.bind(process.stdout)

const option = (name: string): string | undefined => {
  const index = args.indexOf(name)
  return index >= 0 ? args[index + 1] : undefined
}

const print = (value: object): Promise<void> =>
  new Promise((resolve, reject) => {
    // pi redirects process.stdout while an agent is running so model noise is
    // kept off the protocol stream. Retain the original writer for the device
    // protocol itself, including its terminal frame.
    writeProtocolOutput(`${JSON.stringify(value)}\n`, (error) => {
      if (error) reject(error)
      else resolve()
    })
  })

const usage = (): never => {
  process.stderr.write("Usage: jingler-device <enroll|serve|managed-command|install-service|status|rotate-key|revoke-local> [options]\n")
  process.exit(2)
}

const readCredentialStdin = async (): Promise<unknown> => {
  const chunks: Array<Buffer> = []
  let length = 0
  for await (const chunk of process.stdin) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    length += bytes.byteLength
    if (length > 128 * 1_024) throw new Error("Device enrollment credential is too large")
    chunks.push(bytes)
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"))
  } catch {
    throw new Error("Device enrollment credential is invalid")
  }
}

const main = async (): Promise<void> => {
  switch (command) {
    case "managed-command": {
      const inputFile = option("--input")
      const root = option("--root")
      const targetId = option("--target-id")
      if (!inputFile || !root || !targetId) {
        throw new Error(
          "managed-command requires --input, --root and --target-id"
        )
      }
      const command = Schema.decodeUnknownSync(RemoteSessionCommandSchema)(
        JSON.parse(await readFile(inputFile, "utf8")),
        { onExcessProperty: "error" }
      )
      await runManagedCommand(
        command,
        makeLiveDeviceSessionCommandExecutor(root, targetId),
        print
      )
      // This entrypoint is deliberately one-shot. The shared cli-adapters
      // runtime retains background handles used by the long-lived device
      // daemon; after the terminal protocol frame is flushed those handles
      // must not keep a Cloudflare exec process alive indefinitely.
      process.exit(0)
      return
    }
    case "direct-session": {
      const socketPath = (await readFile(
        deviceAgentPaths().directSessionSocketFile,
        "utf8"
      )).trim()
      if (!socketPath) throw new Error("Direct session socket is unavailable")
      const socket = createConnection(socketPath)
      socket.once("connect", () => {
        process.stdin.pipe(socket)
        socket.pipe(process.stdout)
      })
      await new Promise<void>((resolve, reject) => {
        socket.once("error", reject)
        socket.once("close", () => resolve())
      })
      return
    }
    case "enroll": {
      const serverUrl = option("--server")
      if (!serverUrl) throw new Error("enroll requires --server")
      const result = await enrollOwnedDevice({
        serverUrl,
        credential: await readCredentialStdin(),
        displayName: option("--name")
      })
      if (args.includes("--install-service")) {
        await installDeviceService({
          ...(process.env.JINGLER_HOME ? { jinglerHome: process.env.JINGLER_HOME } : {})
        })
      }
      await print(result)
      return
    }
    case "serve": {
      const controller = new AbortController()
      process.once("SIGINT", () => controller.abort())
      process.once("SIGTERM", () => controller.abort())
      const result = await serveDevice({
        subject: option("--subject"),
        deviceId: option("--device-id"),
        serverUrl: option("--server"),
        signal: controller.signal
      })
      if (result === "revoked") {
        await revokeLocalDevice()
        await removeDeviceService()
      }
      // Runtime services may own long-lived Node handles (for example an
      // embedded callback server). At this point the control connection and
      // every tracked session task have settled, so do not let those handles
      // keep a revoked or stopped daemon orphaned under launchd.
      process.exit(0)
      return
    }
    case "install-service": {
      const subject = option("--subject")
      const deviceId = option("--device-id")
      const serverUrl = option("--server")
      if (!subject || !deviceId || !serverUrl) {
        throw new Error("install-service requires --subject, --device-id and --server")
      }
      await persistEnrollment(deviceAgentPaths(), { subject, deviceId, serverUrl })
      await print(
        await installDeviceService({
          ...(process.env.JINGLER_HOME ? { jinglerHome: process.env.JINGLER_HOME } : {})
        })
      )
      return
    }
    case "status":
      await print(await deviceStatus())
      return
    case "rotate-key":
      await print({ version: 1, publicKey: await rotateLocalDeviceKey() })
      return
    case "revoke-local":
      await removeDeviceService()
      await revokeLocalDevice()
      await print({ version: 1, state: "unpaired" })
      return
    default:
      usage()
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
})
