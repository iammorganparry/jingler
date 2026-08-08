import { join } from "node:path"

/**
 * Locate the standalone device-agent bundle without leaking Electron paths into
 * cli-adapters. electron-builder copies it beside app.asar in production; the
 * built desktop and dev server use the workspace build produced by the normal
 * desktop build/e2e setup.
 */
export const resolveDeviceAgentBundlePath = (
  packaged: boolean,
  resourcesPath: string,
  mainDir: string
): string =>
  packaged
    ? join(resourcesPath, "device-agent", "jingler-device.mjs")
    : join(mainDir, "../../../device-agent/dist/jingler-device.mjs")
