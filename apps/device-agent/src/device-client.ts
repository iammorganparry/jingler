import type {
  DeviceEnrollmentCredentialResponse,
  DeviceRecord,
  PendingDeviceRegistrationRequest,
} from "@jingler/core"
import {
  DeviceEnrollmentCredentialResponse as DeviceEnrollmentCredentialResponseSchema,
  DeviceRegistrationResponse as DeviceRegistrationResponseSchema
} from "@jingler/core"
import { Data, Schema } from "effect"

export interface DeviceEnrollment {
  readonly subject: string
  readonly deviceId: string
  readonly serverUrl: string
}

export class DeviceEnrollmentError extends Data.TaggedError("DeviceEnrollmentError")<{
  readonly phase: "credential" | "exchange" | "response"
  readonly message: string
  readonly status?: number
  readonly cause?: unknown
}> {}

export interface ExchangeDeviceEnrollmentInput {
  readonly serverUrl: string
  readonly credential: unknown
  readonly registration: PendingDeviceRegistrationRequest
}

export interface ExchangeDeviceEnrollmentDependencies {
  readonly fetch: (input: string, init: RequestInit) => Promise<Response>
}

const defaultDependencies: ExchangeDeviceEnrollmentDependencies = {
  fetch: (input, init) => fetch(input, init)
}

const checkedServerUrl = (value: string): string => {
  try {
    const url = new URL(value)
    if (
      !(url.protocol === "https:" || url.protocol === "http:") ||
      url.username ||
      url.password ||
      url.hash
    ) {
      throw new Error("unsupported URL")
    }
    return url.toString()
  } catch (cause) {
    throw new DeviceEnrollmentError({
      phase: "credential",
      message: "Jingler server URL is invalid",
      cause
    })
  }
}

const decodeCredential = (value: unknown): DeviceEnrollmentCredentialResponse => {
  try {
    return Schema.decodeUnknownSync(DeviceEnrollmentCredentialResponseSchema)(value, {
      onExcessProperty: "error"
    })
  } catch (cause) {
    throw new DeviceEnrollmentError({
      phase: "credential",
      message: "Device enrollment credential is invalid",
      cause
    })
  }
}

const registrationUrl = (serverUrl: string): string =>
  new URL("/api/devices/enrollments/exchange", serverUrl).toString()

/**
 * Exchanges the opaque, single-use credential for durable device ownership.
 * The credential is deliberately accepted as unknown so it is validated at
 * the daemon boundary before any network request is made.
 */
export const exchangeDeviceEnrollment = async (
  input: ExchangeDeviceEnrollmentInput,
  dependencies: ExchangeDeviceEnrollmentDependencies = defaultDependencies
): Promise<{ readonly enrollment: DeviceEnrollment; readonly device: DeviceRecord }> => {
  const serverUrl = checkedServerUrl(input.serverUrl)
  const credential = decodeCredential(input.credential)
  let response: Response
  try {
    response = await dependencies.fetch(registrationUrl(serverUrl), {
      method: "POST",
      headers: {
        authorization: `Bearer ${credential.token}`,
        "content-type": "application/json",
        accept: "application/json"
      },
      body: JSON.stringify({
        version: 1,
        credentialId: credential.claim.claimId,
        registration: input.registration
      })
    })
  } catch (cause) {
    throw new DeviceEnrollmentError({
      phase: "exchange",
      message: "Device enrollment exchange failed",
      cause
    })
  }
  if (!response.ok) {
    throw new DeviceEnrollmentError({
      phase: "exchange",
      message:
        response.status === 409
          ? "Device enrollment credential was already used"
          : response.status === 410
            ? "Device enrollment credential expired"
            : "Device enrollment exchange failed",
      status: response.status
    })
  }
  try {
    const registered = Schema.decodeUnknownSync(DeviceRegistrationResponseSchema)(
      await response.json(),
      { onExcessProperty: "error" }
    )
    if (
      registered.device.deviceId !== credential.claim.deviceId ||
      registered.device.publicKey.value !== input.registration.publicKey.value
    ) {
      throw new Error("Device enrollment response scope mismatch")
    }
    return {
      enrollment: {
        subject: credential.claim.subject,
        deviceId: registered.device.deviceId,
        serverUrl
      },
      device: registered.device
    }
  } catch (cause) {
    throw new DeviceEnrollmentError({
      phase: "response",
      message: "Device enrollment response is invalid",
      cause
    })
  }
}
