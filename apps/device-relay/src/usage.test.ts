import { describe, expect, it } from "vitest"
import {
  RELAY_USAGE_POLICY,
  admitRelayAttachment,
  allowRelayControlOperation,
  emptyRelayUsage,
  recordRelayCiphertext,
  releaseRelayAttachment
} from "./usage.js"

describe("relay usage policy", () => {
  it("enforces frame concurrency quota and rate limits", () => {
    let state = emptyRelayUsage(100)
    for (let index = 0; index < RELAY_USAGE_POLICY.maximumConcurrentClientsPerDevice; index += 1) {
      const result = admitRelayAttachment(state, 100)
      expect(result.status).toBe("admitted")
      state = result.next
    }
    expect(admitRelayAttachment(state, 100).status).toBe("concurrency-exceeded")
    state = releaseRelayAttachment(state)
    state = recordRelayCiphertext(state, "in", 500)
    state = recordRelayCiphertext(state, "out", 500)
    expect(admitRelayAttachment(state, 101, 1_000).status).toBe("quota-exceeded")
    expect(() =>
      recordRelayCiphertext(state, "in", RELAY_USAGE_POLICY.maximumFrameBytes + 1)
    ).toThrow("exceeds policy")
  })

  it("allows control and revocation after quota exhaustion", () => {
    const exhausted = recordRelayCiphertext(emptyRelayUsage(100), "in", 1_000)
    expect(admitRelayAttachment(exhausted, 101, 1_000).status).toBe("quota-exceeded")
    expect(allowRelayControlOperation()).toBe(true)
  })

  it("meters ciphertext bytes by account and device", async () => {
    const usage = env.RELAY_USAGE.getByName("account:metering")
    expect(await usage.admit({
      attachmentId: "attachment-1",
      deviceId: "device-1",
      clientInstanceId: "client-1",
      sourceIp: "192.0.2.1"
    }, 10_000, 100)).toBe("admitted")
    expect(await usage.recordTransfer("device-1", 500, 10_000)).toBe("recorded")
    expect(await usage.recordTransfer("device-2", 250, 10_000)).toBe("recorded")
    await expect(usage.snapshot(10_000, "device-1")).resolves.toMatchObject({
      ciphertextBytesIn: 750,
      ciphertextBytesOut: 750,
      deviceId: "device-1",
      deviceCiphertextBytesIn: 500,
      deviceCiphertextBytesOut: 500,
      activeAttachments: 1,
      quotaBytes: 10_000
    })
    await expect(usage.snapshot(10_000, "device-2")).resolves.toMatchObject({
      ciphertextBytesIn: 750,
      ciphertextBytesOut: 750,
      deviceCiphertextBytesIn: 250,
      deviceCiphertextBytesOut: 250
    })
    await expect(usage.snapshot(10_000)).resolves.toMatchObject({
      ciphertextBytesIn: 750,
      ciphertextBytesOut: 750,
      activeAttachments: 1,
      quotaBytes: 10_000
    })
    await usage.release("attachment-1")
    await expect(usage.snapshot(10_000)).resolves.toMatchObject({
      activeAttachments: 0
    })
  })

  it("reserves transfer chunks and refunds the unused tail on close", async () => {
    const usage = env.RELAY_USAGE.getByName("account:reservations")
    await expect(usage.admit({
      attachmentId: "reservation-attachment",
      deviceId: "device-1",
      clientInstanceId: "client-1",
      sourceIp: "203.0.113.1"
    }, 10_000_000, 100)).resolves.toBe("admitted")
    const reservation = await usage.reserveTransfer("device-1", 500, 10_000_000)
    expect(reservation).toEqual({
      status: "reserved",
      bytes: RELAY_USAGE_POLICY.transferReservationBytes
    })
    await expect(usage.snapshot(10_000_000, "device-1")).resolves.toMatchObject({
      ciphertextBytesIn: RELAY_USAGE_POLICY.transferReservationBytes,
      ciphertextBytesOut: RELAY_USAGE_POLICY.transferReservationBytes,
      deviceCiphertextBytesIn: RELAY_USAGE_POLICY.transferReservationBytes,
      deviceCiphertextBytesOut: RELAY_USAGE_POLICY.transferReservationBytes
    })

    await usage.release(
      "reservation-attachment",
      "device-1",
      RELAY_USAGE_POLICY.transferReservationBytes - 500
    )
    await expect(usage.snapshot(10_000_000, "device-1")).resolves.toMatchObject({
      ciphertextBytesIn: 500,
      ciphertextBytesOut: 500,
      deviceCiphertextBytesIn: 500,
      deviceCiphertextBytesOut: 500
    })
    await usage.release(
      "reservation-attachment",
      "device-1",
      RELAY_USAGE_POLICY.transferReservationBytes - 500
    )
    await expect(usage.snapshot(10_000_000, "device-1")).resolves.toMatchObject({
      ciphertextBytesIn: 500,
      ciphertextBytesOut: 500,
      deviceCiphertextBytesIn: 500,
      deviceCiphertextBytesOut: 500
    })
  })

  it("uses one account-ledger reservation for many small encrypted frames", async () => {
    const usage = env.RELAY_USAGE.getByName("account:batched-metering")
    const first = await usage.reserveTransfer("device-1", 128, 10_000_000)
    expect(first).toEqual({
      status: "reserved",
      bytes: RELAY_USAGE_POLICY.transferReservationBytes
    })
    await expect(usage.snapshot(10_000_000)).resolves.toMatchObject({
      ciphertextBytesIn: RELAY_USAGE_POLICY.transferReservationBytes,
      ciphertextBytesOut: RELAY_USAGE_POLICY.transferReservationBytes
    })
  })

  it("blocks new data attachments after quota exhaustion", async () => {
    const usage = env.RELAY_USAGE.getByName("account:quota")
    expect(await usage.admit({
      attachmentId: "attachment-1",
      deviceId: "device-1",
      clientInstanceId: "client-1",
      sourceIp: "192.0.2.2"
    }, 1_000, 100)).toBe("admitted")
    expect(await usage.recordTransfer("device-1", 500, 1_000)).toBe("recorded")
    expect(await usage.admit({
      attachmentId: "attachment-2",
      deviceId: "device-1",
      clientInstanceId: "client-2",
      sourceIp: "192.0.2.3"
    }, 1_000, 101)).toBe("quota-exceeded")
    expect(allowRelayControlOperation()).toBe(true)
  })

  it("enforces durable concurrency while keeping attachment retries idempotent", async () => {
    const usage = env.RELAY_USAGE.getByName("account:durable-concurrency")
    for (
      let index = 0;
      index < RELAY_USAGE_POLICY.maximumConcurrentClientsPerDevice;
      index += 1
    ) {
      await expect(usage.admit({
        attachmentId: `attachment-${index}`,
        deviceId: "device-shared",
        clientInstanceId: `client-${index}`,
        sourceIp: `192.0.2.${index + 1}`
      }, Number.MAX_SAFE_INTEGER, 100)).resolves.toBe("admitted")
    }
    await expect(usage.admit({
      attachmentId: "attachment-extra",
      deviceId: "device-shared",
      clientInstanceId: "client-extra",
      sourceIp: "192.0.2.100"
    }, Number.MAX_SAFE_INTEGER, 100)).resolves.toBe("concurrency-exceeded")
    await expect(usage.admit({
      attachmentId: "attachment-0",
      deviceId: "device-shared",
      clientInstanceId: "client-0",
      sourceIp: "192.0.2.1"
    }, Number.MAX_SAFE_INTEGER, 100)).resolves.toBe("admitted")
  })

  it("rate limits attachment attempts independently by account client and ip", async () => {
    const usage = env.RELAY_USAGE.getByName("account:rate-limit")
    let result: Awaited<ReturnType<typeof usage.admit>> = "admitted"
    for (
      let index = 0;
      index <= RELAY_USAGE_POLICY.maximumAttachmentAttemptsPerMinute;
      index += 1
    ) {
      result = await usage.admit({
        attachmentId: `attachment-${index}`,
        deviceId: `device-${index}`,
        clientInstanceId: "client-shared",
        sourceIp: "192.0.2.4"
      }, Number.MAX_SAFE_INTEGER, 100)
    }
    expect(result).toBe("rate-limited")
  })
})
import { env } from "cloudflare:test"
