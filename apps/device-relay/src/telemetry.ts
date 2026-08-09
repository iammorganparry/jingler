export type DeviceRelaySecurityEvent =
  | "bootstrap_discovery"
  | "device_registration"
  | "device_claim"
  | "grant_admission"
  | "presence_change"
  | "client_attachment"
  | "controller_lease"
  | "rejected_grant"
  | "pairing_attempt"
  | "reconnect_depth"
  | "replay_truncation"
  | "device_revocation"

type TelemetryValue = string | number | boolean | null

export interface DeviceRelayTelemetryRecord {
  readonly component: "device-relay"
  readonly level: "info" | "warn"
  readonly event: DeviceRelaySecurityEvent
  readonly timestamp: string
  readonly [key: string]: TelemetryValue
}

export const telemetryRecord = (
  event: DeviceRelaySecurityEvent,
  fields: Readonly<Record<string, TelemetryValue>>,
  level: "info" | "warn" = "info",
  timestamp = new Date().toISOString()
): DeviceRelayTelemetryRecord => ({
  ...fields,
  component: "device-relay",
  level,
  event,
  timestamp
})

/** JSON-only security telemetry. Callers pass identifiers and counters, never payloads or secrets. */
export const deviceRelayTelemetry = (
  event: DeviceRelaySecurityEvent,
  fields: Readonly<Record<string, TelemetryValue>>,
  level: "info" | "warn" = "info"
): void => {
  console.log(JSON.stringify(telemetryRecord(event, fields, level)))
}
