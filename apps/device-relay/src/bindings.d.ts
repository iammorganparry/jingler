interface DeviceRelaySecrets {
  /** Must match the server's DEVICE_RELAY_SIGNING_SECRET. */
  DEVICE_RELAY_SIGNING_SECRET: string
}

interface Env extends DeviceRelaySecrets {}

declare namespace Cloudflare {
  interface Env extends DeviceRelaySecrets {}
}
