interface DeviceRelaySecrets {
  /** Must match the server's DEVICE_RELAY_SIGNING_SECRET. */
  DEVICE_RELAY_SIGNING_SECRET: string
  /** Native Cloudflare limiter for enrollment and device challenge issuance. */
  UNAUTHENTICATED_RATE_LIMITER: RateLimit
}

interface Env extends DeviceRelaySecrets {}

declare namespace Cloudflare {
  interface Env extends DeviceRelaySecrets {}
}
