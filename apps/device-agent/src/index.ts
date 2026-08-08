import { deviceAgentPaths, deviceStatus, registerPendingDevice, revokeLocalDevice, rotateLocalDeviceKey, serveDevice } from "./runtime.js"

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
  process.stderr.write(
    "Usage: jingler-device <pair|serve|status|rotate-key|revoke-local> [options]\n"
  )
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
      if (result === "revoked") process.exitCode = 3
      return
    }
    case "status":
      print(await deviceStatus())
      return
    case "rotate-key":
      print({ version: 1, publicKey: await rotateLocalDeviceKey() })
      return
    case "revoke-local":
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
