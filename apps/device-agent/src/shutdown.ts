import { killAllChildren } from "@jingler/cli-adapters"

export const shutdownDeviceAgent = (exit: (code: number) => void = process.exit): number => {
  const killed = killAllChildren()
  exit(0)
  return killed
}
