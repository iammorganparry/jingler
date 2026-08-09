import {
  deviceAgentPaths,
  deviceStatus,
  enrollOwnedDevice,
  persistEnrollment,
  revokeLocalDevice,
  rotateLocalDeviceKey,
  serveDevice
} from "./runtime.js"
import { installDeviceService, removeDeviceService } from "./device-service.js"
import { createConnection } from "node:net"
import { readFile } from "node:fs/promises"

const args = process.argv.slice(2)
const command = args[0]

const option = (name: string): string | undefined => {
  const index = args.indexOf(name)
  return index >= 0 ? args[index + 1] : undefined
}

const print = (value: unknown): void => {
  process.stdout.write(`${JSON.stringify(value)}\n`)
}

const usage = (): never => {
  process.stderr.write("Usage: jingler-device <enroll|serve|install-service|status|rotate-key|revoke-local> [options]\n")
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
      print(result)
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
      // Some harness adapters own long-lived Node handles (for example an
      // embedded callback server). At this point the control connection and
      // every tracked session task have settled, so do not let those adapter
      // handles keep a revoked or stopped daemon orphaned under launchd.
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
      print(
        await installDeviceService({
          ...(process.env.JINGLER_HOME ? { jinglerHome: process.env.JINGLER_HOME } : {})
        })
      )
      return
    }
    case "status":
      print(await deviceStatus())
      return
    case "rotate-key":
      print({ version: 1, publicKey: await rotateLocalDeviceKey() })
      return
    case "revoke-local":
      await removeDeviceService()
      await revokeLocalDevice()
      print({ version: 1, state: "unpaired" })
      return
    default:
      usage()
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
})
