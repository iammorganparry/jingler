import { describe, expect, it, vi } from "vitest"
import { deviceRelayTelemetry, telemetryRecord } from "./telemetry.js"

describe("device relay security telemetry", () => {
  it("emits stable structured JSON without caller-controlled base fields", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined)
    deviceRelayTelemetry(
      "rejected_grant",
      {
        audience: "session-tunnel",
        component: "attacker-value",
        path: "/v1/session-tunnels/session_opaque",
        reason: "wrong-audience"
      },
      "warn"
    )
    expect(log).toHaveBeenCalledOnce()
    const record: Record<string, unknown> = JSON.parse(String(log.mock.calls[0]?.[0]))
    expect(record).toMatchObject({
      component: "device-relay",
      level: "warn",
      event: "rejected_grant",
      audience: "session-tunnel",
      reason: "wrong-audience"
    })
    expect(record.timestamp).toEqual(expect.any(String))
    log.mockRestore()
  })

  it("keeps required telemetry free of credentials and payload content", () => {
    const records = [
      telemetryRecord(
        "pairing_attempt",
        { deviceId: "device_opaque", failedAttempts: 2, outcome: "invalid-code" },
        "warn",
        "2026-08-08T00:00:00.000Z"
      ),
      telemetryRecord("reconnect_depth", {
        acknowledgedSequence: 10,
        endpoint: "device",
        hasMore: false,
        replayDepth: 3,
        sessionId: "session_opaque"
      }),
      telemetryRecord("replay_truncation", {
        droppedEnvelopes: 4,
        reason: "retention-bound",
        sessionId: "session_opaque"
      }),
      telemetryRecord("device_revocation", {
        deviceId: "device_opaque",
        generation: 2,
        registrySocketsClosed: 1,
        tunnelSocketsClosed: 2
      })
    ]
    const serialized = JSON.stringify(records)
    expect(serialized).not.toContain("Bearer")
    expect(serialized).not.toContain("pairingCode")
    expect(serialized).not.toContain("signature")
    expect(serialized).not.toContain("ciphertext")
    expect(serialized).not.toContain("prompt")
  })
})
