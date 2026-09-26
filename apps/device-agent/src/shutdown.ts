import { killAllChildren } from "@jingler/cli-adapters/child-registry"

export const shutdownDeviceAgent = (exit: (code: number) => void = process.exit): number => {
  const killed = killAllChildren()
  exit(0)
  return killed
}
