import {
  deviceAgentPaths,
  deviceStatus,
  persistEnrollment,
  registerPendingDevice,
  revokeLocalDevice,
  rotateLocalDeviceKey,
  serveDevice
} from "./runtime.js"
import { installDeviceService, removeDeviceService } from "./device-service.js"

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
  process.stderr.write("Usage: jingler-device <pair|serve|install-service|status|rotate-key|revoke-local> [options]\n")
  process.exit(2)
}

const main = async (): Promise<void> => {
  switch (command) {
    case "pair": {
      const relayUrl = option("--relay") ?? process.env.JINGLER_DEVICE_RELAY_URL
      if (!relayUrl) throw new Error("pair requires --relay or JINGLER_DEVICE_RELAY_URL")
      print(await registerPendingDevice(relayUrl, deviceAgentPaths(), option("--name")))
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
