import { Schema } from "effect"
import { CliKind } from "./domain.js"
import { RuntimeCapabilityManifest } from "./runtime/capability-manifest.js"
import {
  AuthKind,
  AuthStatus,
  ProviderConnectionId,
  ProviderId
} from "./runtime/provider-connection.js"

/** Wire revision shared by the server, relay Worker, desktop, and device daemon. */
export const REMOTE_PROTOCOL_VERSION = 1 as const
export const DEVICE_BOOTSTRAP_CONFIGURATION_VERSION = 1 as const
export const DEVICE_CLAIM_VERSION = 1 as const
export const DEVICE_REGISTRY_VERSION = 1 as const
export const DEVICE_ENROLLMENT_VERSION = 1 as const
export const DEVICE_GRANT_VERSION = 1 as const
export const CLIENT_ATTACHMENT_VERSION = 1 as const
export const REMOTE_SESSION_INVENTORY_VERSION = 1 as const
export const CONTROLLER_LEASE_VERSION = 1 as const
/** Upper bound enforced independently by the issuer and relay verifier. */
export const REMOTE_GRANT_MAX_TTL_SECONDS = 15 * 60

const Identity = Schema.String.pipe(Schema.minLength(1), Schema.maxLength(128))
const OpaqueId = Identity.pipe(
  Schema.pattern(/^[A-Za-z0-9_-]+$/, { identifier: "RemoteOpaqueId" })
)
const Base64Url = Schema.String.pipe(
  Schema.minLength(1),
  Schema.pattern(/^[A-Za-z0-9_-]+$/, { identifier: "RemoteBase64Url" })
)
const EpochSeconds = Schema.Int.pipe(Schema.nonNegative())
const Generation = Schema.Int.pipe(Schema.between(1, Number.MAX_SAFE_INTEGER))
const Sequence = Schema.Int.pipe(Schema.between(1, Number.MAX_SAFE_INTEGER))

export const RemoteDeviceId = OpaqueId
export type RemoteDeviceId = Schema.Schema.Type<typeof RemoteDeviceId>

export const RemoteSessionId = OpaqueId
export type RemoteSessionId = Schema.Schema.Type<typeof RemoteSessionId>

export const RemoteClientInstanceId = OpaqueId
export type RemoteClientInstanceId = Schema.Schema.Type<
  typeof RemoteClientInstanceId
>

/** Secret-free deployment metadata discovered before a client knows the relay. */
export const DeviceBootstrapConfiguration = Schema.Struct({
  version: Schema.Literal(DEVICE_BOOTSTRAP_CONFIGURATION_VERSION),
  enabled: Schema.Boolean,
  relayOrigin: Schema.String.pipe(
    Schema.pattern(/^https?:\/\/[^\s/]+(?::\d+)?$/u, {
      identifier: "DeviceRelayOrigin"
    })
  ),
  protocols: Schema.Array(
    Schema.Literal("jingler-device-v1", "jingler-session-v1")
  ).pipe(Schema.minItems(1), Schema.maxItems(8)),
  issuedAt: EpochSeconds,
  expiresAt: EpochSeconds,
  cacheMaxAgeSeconds: Schema.Int.pipe(Schema.between(0, 3_600))
})
export type DeviceBootstrapConfiguration = Schema.Schema.Type<
  typeof DeviceBootstrapConfiguration
>

/** Typed, serializable failures shared by the server, relay, and clients. */
export class DeviceControlPlaneError extends Schema.TaggedError<DeviceControlPlaneError>()(
  "DeviceControlPlaneError",
  {
    reason: Schema.Literal(
      "disabled",
      "invalid-configuration",
      "invalid-claim",
      "claim-mismatch",
      "replayed",
      "invalid-grant",
      "offline",
      "revoked",
      "not-found",
      "quota-exceeded",
      "rate-limited",
      "concurrency-exceeded",
      "stale-controller"
    ),
    message: Schema.String,
    retryable: Schema.Boolean
  }
) {}

/** Short-lived single-use bootstrap capability delivered to a daemon over SSH. */
export const DeviceClaim = Schema.Struct({
  version: Schema.Literal(DEVICE_CLAIM_VERSION),
  claimId: OpaqueId,
  subject: Identity,
  deviceId: RemoteDeviceId,
  clientInstanceId: RemoteClientInstanceId,
  audience: Schema.Literal("device-claim"),
  issuedAt: EpochSeconds,
  expiresAt: EpochSeconds
})
export type DeviceClaim = Schema.Schema.Type<typeof DeviceClaim>

export const DeviceClaimRequest = Schema.Struct({
  version: Schema.Literal(DEVICE_CLAIM_VERSION),
  deviceId: RemoteDeviceId,
  clientInstanceId: RemoteClientInstanceId
})
export type DeviceClaimRequest = Schema.Schema.Type<typeof DeviceClaimRequest>

/** Preferred product name for the invisible, SSH-delivered enrollment claim. */
export const DeviceEnrollmentCredential = DeviceClaim
export type DeviceEnrollmentCredential = DeviceClaim

export const DeviceEnrollmentCredentialRequest = DeviceClaimRequest
export type DeviceEnrollmentCredentialRequest = DeviceClaimRequest

export const DeviceEnrollmentCredentialResponse = Schema.Struct({
  version: Schema.Literal(DEVICE_CLAIM_VERSION),
  claim: DeviceEnrollmentCredential,
  token: Schema.String.pipe(Schema.minLength(1))
})
export type DeviceEnrollmentCredentialResponse = Schema.Schema.Type<
  typeof DeviceEnrollmentCredentialResponse
>

/** Public identity only. Private device keys never cross a Jingler API boundary. */
export const DevicePublicKey = Schema.Struct({
  algorithm: Schema.Literal("Ed25519"),
  encoding: Schema.Literal("base64url"),
  value: Base64Url.pipe(Schema.minLength(43), Schema.maxLength(43))
})
export type DevicePublicKey = Schema.Schema.Type<typeof DevicePublicKey>

/** Distinct static key used only for session-key agreement; never for identity signatures. */
export const DeviceEncryptionPublicKey = Schema.Struct({
  algorithm: Schema.Literal("X25519"),
  encoding: Schema.Literal("base64url"),
  value: Base64Url.pipe(Schema.minLength(43), Schema.maxLength(43))
})
export type DeviceEncryptionPublicKey = Schema.Schema.Type<typeof DeviceEncryptionPublicKey>

export const RemoteDeviceCapability = Schema.Literal(
  "session.start",
  "session.input",
  "session.cancel",
  "session.observe",
  "project.manage"
)
export type RemoteDeviceCapability = Schema.Schema.Type<
  typeof RemoteDeviceCapability
>

/** Bounded, declarative device features used for scheduling and UI affordances. */
export const RemoteDeviceCapabilities = Schema.Struct({
  version: Schema.Literal(REMOTE_PROTOCOL_VERSION),
  capabilities: Schema.Array(RemoteDeviceCapability).pipe(Schema.maxItems(16)),
  harnesses: Schema.Array(CliKind).pipe(Schema.maxItems(16)),
  maxConcurrentSessions: Schema.Int.pipe(Schema.between(1, 64)),
  /** Present on pi-capable agents; absent only on legacy device records. */
  runtime: Schema.optional(RuntimeCapabilityManifest),
  providerConnections: Schema.optional(
    Schema.Array(
      Schema.Struct({
        id: ProviderConnectionId,
        providerId: ProviderId,
        authKind: AuthKind,
        status: AuthStatus
      })
    ).pipe(Schema.maxItems(64))
  )
})
export type RemoteDeviceCapabilities = Schema.Schema.Type<
  typeof RemoteDeviceCapabilities
>

export const RemoteDevicePlatform = Schema.Struct({
  os: Schema.String.pipe(Schema.minLength(1), Schema.maxLength(64)),
  arch: Schema.String.pipe(Schema.minLength(1), Schema.maxLength(64))
})
export type RemoteDevicePlatform = Schema.Schema.Type<
  typeof RemoteDevicePlatform
>

export const PendingDeviceRegistrationRequest = Schema.Struct({
  version: Schema.Literal(REMOTE_PROTOCOL_VERSION),
  displayName: Schema.String.pipe(Schema.minLength(1), Schema.maxLength(120)),
  platform: RemoteDevicePlatform,
  publicKey: DevicePublicKey,
  encryptionPublicKey: Schema.optional(DeviceEncryptionPublicKey),
  capabilities: RemoteDeviceCapabilities,
  agentVersion: Schema.optional(
    Schema.String.pipe(Schema.minLength(1), Schema.maxLength(64))
  )
})
export type PendingDeviceRegistrationRequest = Schema.Schema.Type<
  typeof PendingDeviceRegistrationRequest
>

/** Daemon exchange body. The credential itself is sent as the Bearer token. */
export const DeviceRegistrationRequest = Schema.Struct({
  version: Schema.Literal(DEVICE_ENROLLMENT_VERSION),
  credentialId: OpaqueId,
  registration: PendingDeviceRegistrationRequest
})
export type DeviceRegistrationRequest = Schema.Schema.Type<
  typeof DeviceRegistrationRequest
>

/** Registration submitted by the daemon with a server-issued one-time claim. */
export const ClaimedDeviceRegistrationRequest = Schema.Struct({
  version: Schema.Literal(DEVICE_CLAIM_VERSION),
  claim: DeviceClaim,
  registration: PendingDeviceRegistrationRequest
})
export type ClaimedDeviceRegistrationRequest = Schema.Schema.Type<
  typeof ClaimedDeviceRegistrationRequest
>

export const PendingDeviceRegistrationResponse = Schema.Struct({
  version: Schema.Literal(REMOTE_PROTOCOL_VERSION),
  pendingDeviceId: RemoteDeviceId,
  deviceId: RemoteDeviceId,
  pairingCode: Schema.String.pipe(
    Schema.pattern(/^[A-HJ-NP-Z2-9]{8}$/, { identifier: "RemotePairingCode" })
  ),
  expiresAt: EpochSeconds
})
export type PendingDeviceRegistrationResponse = Schema.Schema.Type<
  typeof PendingDeviceRegistrationResponse
>

export const PairingClaimRequest = Schema.Struct({
  version: Schema.Literal(REMOTE_PROTOCOL_VERSION),
  pendingDeviceId: RemoteDeviceId,
  pairingCode: Schema.String.pipe(
    Schema.pattern(/^[A-HJ-NP-Z2-9]{8}$/, { identifier: "RemotePairingCode" })
  )
})
export type PairingClaimRequest = Schema.Schema.Type<typeof PairingClaimRequest>

export const RemoteDeviceState = Schema.Literal("active", "revoked")
export type RemoteDeviceState = Schema.Schema.Type<typeof RemoteDeviceState>

export const RemoteDevicePresenceState = Schema.Literal("online", "offline")
export type RemoteDevicePresenceState = Schema.Schema.Type<
  typeof RemoteDevicePresenceState
>

export const AccountDevicePresenceState = Schema.Literal(
  "online",
  "offline",
  "reconnecting"
)
export type AccountDevicePresenceState = Schema.Schema.Type<
  typeof AccountDevicePresenceState
>

/** Durable account-owned metadata. Relay presence is joined separately. */
export const DeviceRecord = Schema.Struct({
  version: Schema.Literal(DEVICE_REGISTRY_VERSION),
  deviceId: RemoteDeviceId,
  accountId: Identity,
  identityFingerprint: Base64Url.pipe(
    Schema.minLength(43),
    Schema.maxLength(86)
  ),
  displayName: Schema.String.pipe(Schema.minLength(1), Schema.maxLength(120)),
  platform: RemoteDevicePlatform,
  publicKey: DevicePublicKey,
  encryptionPublicKey: Schema.optional(DeviceEncryptionPublicKey),
  capabilities: RemoteDeviceCapabilities,
  agentVersion: Schema.optional(
    Schema.NullOr(Schema.String.pipe(Schema.minLength(1), Schema.maxLength(64)))
  ),
  state: RemoteDeviceState,
  generation: Generation,
  enrolledAt: EpochSeconds,
  createdAt: EpochSeconds,
  updatedAt: EpochSeconds,
  revokedAt: Schema.NullOr(EpochSeconds)
})
export type DeviceRecord = Schema.Schema.Type<typeof DeviceRecord>

export const DevicePresence = Schema.Struct({
  version: Schema.Literal(DEVICE_REGISTRY_VERSION),
  deviceId: RemoteDeviceId,
  state: AccountDevicePresenceState,
  connectedAt: Schema.NullOr(EpochSeconds),
  lastSeenAt: Schema.NullOr(EpochSeconds),
  activeSessionIds: Schema.Array(RemoteSessionId).pipe(Schema.maxItems(64))
})
export type DevicePresence = Schema.Schema.Type<typeof DevicePresence>

export const AccountDevice = Schema.Struct({
  ...DeviceRecord.fields,
  presence: DevicePresence
})
export type AccountDevice = Schema.Schema.Type<typeof AccountDevice>

export const AccountDeviceListResponse = Schema.Struct({
  version: Schema.Literal(DEVICE_REGISTRY_VERSION),
  devices: Schema.Array(AccountDevice).pipe(Schema.maxItems(256))
})
export type AccountDeviceListResponse = Schema.Schema.Type<
  typeof AccountDeviceListResponse
>

export const DeviceRegistrationResponse = Schema.Struct({
  version: Schema.Literal(DEVICE_ENROLLMENT_VERSION),
  device: DeviceRecord
})
export type DeviceRegistrationResponse = Schema.Schema.Type<
  typeof DeviceRegistrationResponse
>

export const DeviceRegistryInvalidation = Schema.Struct({
  version: Schema.Literal(DEVICE_REGISTRY_VERSION),
  accountId: Identity,
  deviceId: RemoteDeviceId,
  reason: Schema.Literal("enrolled", "presence", "renamed", "revoked"),
  occurredAt: EpochSeconds
})
export type DeviceRegistryInvalidation = Schema.Schema.Type<
  typeof DeviceRegistryInvalidation
>

export const RemoteDevicePresence = Schema.Struct({
  version: Schema.Literal(REMOTE_PROTOCOL_VERSION),
  state: RemoteDevicePresenceState,
  connectedAt: Schema.NullOr(EpochSeconds),
  lastSeenAt: Schema.NullOr(EpochSeconds),
  activeSessionIds: Schema.Array(RemoteSessionId).pipe(Schema.maxItems(64))
})
export type RemoteDevicePresence = Schema.Schema.Type<
  typeof RemoteDevicePresence
>

export const RemoteDevice = Schema.Struct({
  version: Schema.Literal(REMOTE_PROTOCOL_VERSION),
  deviceId: RemoteDeviceId,
  displayName: Schema.String.pipe(Schema.minLength(1), Schema.maxLength(120)),
  platform: RemoteDevicePlatform,
  publicKey: DevicePublicKey,
  encryptionPublicKey: Schema.optional(DeviceEncryptionPublicKey),
  capabilities: RemoteDeviceCapabilities,
  /** Absent when talking to an older relay; null until the first discovery announcement. */
  agentVersion: Schema.optional(
    Schema.NullOr(Schema.String.pipe(Schema.minLength(1), Schema.maxLength(64)))
  ),
  state: RemoteDeviceState,
  generation: Generation,
  createdAt: EpochSeconds,
  updatedAt: EpochSeconds,
  presence: RemoteDevicePresence
})
export type RemoteDevice = Schema.Schema.Type<typeof RemoteDevice>

export const PairingClaimResponse = Schema.Struct({
  version: Schema.Literal(REMOTE_PROTOCOL_VERSION),
  subject: Identity,
  device: RemoteDevice
})
export type PairingClaimResponse = Schema.Schema.Type<
  typeof PairingClaimResponse
>

export const DeviceListResponse = Schema.Struct({
  version: Schema.Literal(REMOTE_PROTOCOL_VERSION),
  devices: Schema.Array(RemoteDevice).pipe(Schema.maxItems(256))
})
export type DeviceListResponse = Schema.Schema.Type<typeof DeviceListResponse>

export const DeviceChallengeRequest = Schema.Struct({
  version: Schema.Literal(REMOTE_PROTOCOL_VERSION),
  subject: Identity,
  deviceId: RemoteDeviceId
})
export type DeviceChallengeRequest = Schema.Schema.Type<
  typeof DeviceChallengeRequest
>

export const DeviceChallenge = Schema.Struct({
  version: Schema.Literal(REMOTE_PROTOCOL_VERSION),
  challengeId: OpaqueId,
  subject: Identity,
  deviceId: RemoteDeviceId,
  nonce: Base64Url.pipe(Schema.minLength(22), Schema.maxLength(128)),
  issuedAt: EpochSeconds,
  expiresAt: EpochSeconds
})
export type DeviceChallenge = Schema.Schema.Type<typeof DeviceChallenge>

export const RemoteRepositoryCapability = Schema.Struct({
  name: Schema.String.pipe(Schema.minLength(1), Schema.maxLength(200)),
  path: Schema.String.pipe(Schema.minLength(1), Schema.maxLength(4_096)),
  defaultBranch: Schema.NullOr(Schema.String.pipe(Schema.maxLength(512))),
  currentBranch: Schema.NullOr(Schema.String.pipe(Schema.maxLength(512))),
  branches: Schema.Array(
    Schema.String.pipe(Schema.minLength(1), Schema.maxLength(512))
  ).pipe(Schema.maxItems(2_048)),
  githubSlug: Schema.NullOr(Schema.String.pipe(Schema.maxLength(512)))
})
export type RemoteRepositoryCapability = Schema.Schema.Type<
  typeof RemoteRepositoryCapability
>

/** A bounded snapshot re-announced whenever the device control socket reconnects. */
export const RemoteDeviceDiscovery = Schema.Struct({
  version: Schema.Literal(REMOTE_PROTOCOL_VERSION),
  agentVersion: Schema.String.pipe(Schema.minLength(1), Schema.maxLength(64)),
  platform: RemoteDevicePlatform,
  capabilities: RemoteDeviceCapabilities,
  repositories: Schema.Array(RemoteRepositoryCapability).pipe(
    Schema.maxItems(1_024)
  )
})
export type RemoteDeviceDiscovery = Schema.Schema.Type<
  typeof RemoteDeviceDiscovery
>

export const EnvironmentDiscovery = Schema.Struct({
  version: Schema.Literal(REMOTE_PROTOCOL_VERSION),
  deviceId: RemoteDeviceId,
  discovery: Schema.NullOr(RemoteDeviceDiscovery),
  updatedAt: Schema.NullOr(EpochSeconds)
})
export type EnvironmentDiscovery = Schema.Schema.Type<typeof EnvironmentDiscovery>

export const DeviceControlClientMessage = Schema.Union(
  Schema.Struct({ type: Schema.Literal("ping") }),
  Schema.Struct({
    type: Schema.Literal("announce"),
    discovery: RemoteDeviceDiscovery
  })
)
export type DeviceControlClientMessage = Schema.Schema.Type<
  typeof DeviceControlClientMessage
>

/** Canonical bytes signed for device connection and key-rotation challenges. */
export const deviceChallengePayload = (
  challenge: DeviceChallenge,
  newPublicKey?: DevicePublicKey
): Uint8Array<ArrayBuffer> =>
  new TextEncoder().encode(
    [
      challenge.version,
      challenge.challengeId,
      challenge.subject,
      challenge.deviceId,
      challenge.nonce,
      challenge.issuedAt,
      challenge.expiresAt,
      newPublicKey ? JSON.stringify(newPublicKey) : ""
    ].join(".")
  )

export const DeviceChallengeExchangeRequest = Schema.Struct({
  version: Schema.Literal(REMOTE_PROTOCOL_VERSION),
  challenge: DeviceChallenge,
  signature: Base64Url.pipe(Schema.minLength(86), Schema.maxLength(86))
})
export type DeviceChallengeExchangeRequest = Schema.Schema.Type<
  typeof DeviceChallengeExchangeRequest
>

export const DeviceRevocationRequest = Schema.Struct({
  version: Schema.Literal(REMOTE_PROTOCOL_VERSION),
  deviceId: RemoteDeviceId
})
export type DeviceRevocationRequest = Schema.Schema.Type<
  typeof DeviceRevocationRequest
>

export const DeviceRenameRequest = Schema.Struct({
  version: Schema.Literal(REMOTE_PROTOCOL_VERSION),
  deviceId: RemoteDeviceId,
  displayName: Schema.String.pipe(Schema.minLength(1), Schema.maxLength(120))
})
export type DeviceRenameRequest = Schema.Schema.Type<typeof DeviceRenameRequest>

export const DeviceKeyRotationRequest = Schema.Struct({
  version: Schema.Literal(REMOTE_PROTOCOL_VERSION),
  challenge: DeviceChallenge,
  newPublicKey: DevicePublicKey,
  signature: Base64Url.pipe(Schema.minLength(86), Schema.maxLength(86))
})
export type DeviceKeyRotationRequest = Schema.Schema.Type<
  typeof DeviceKeyRotationRequest
>

export const DeviceRelayGrantAudience = Schema.Literal(
  "device-control",
  "device-challenge",
  "device-connect",
  "session-tunnel"
)
export type DeviceRelayGrantAudience = Schema.Schema.Type<
  typeof DeviceRelayGrantAudience
>

export const DeviceRelayGrantClaims = Schema.Struct({
  version: Schema.Literal(DEVICE_GRANT_VERSION),
  issuer: Schema.Literal("jingler"),
  audience: DeviceRelayGrantAudience,
  subject: Identity,
  deviceId: Schema.NullOr(RemoteDeviceId),
  sessionId: Schema.NullOr(RemoteSessionId),
  clientInstanceId: Schema.NullOr(RemoteClientInstanceId),
  attachmentGeneration: Schema.NullOr(Generation),
  controllerLeaseGeneration: Schema.NullOr(Generation),
  deviceGeneration: Schema.NullOr(Generation),
  issuedAt: EpochSeconds,
  expiresAt: EpochSeconds,
  grantId: OpaqueId
})
export type DeviceRelayGrantClaims = Schema.Schema.Type<
  typeof DeviceRelayGrantClaims
>

/** Canonical signed grant payload; kept under the explicit control-plane name. */
export const DeviceGrant = DeviceRelayGrantClaims
export type DeviceGrant = DeviceRelayGrantClaims

type DeviceRelayGrantScope = Pick<
  DeviceRelayGrantClaims,
  | "audience"
  | "deviceId"
  | "sessionId"
  | "clientInstanceId"
  | "attachmentGeneration"
  | "controllerLeaseGeneration"
  | "deviceGeneration"
>

/** Shared authorization matrix used by both the Node issuer and Worker verifier. */
export const isValidDeviceRelayGrantScope = (
  claims: DeviceRelayGrantScope
): boolean => {
  switch (claims.audience) {
    case "device-control":
      return (
        claims.sessionId === null &&
        claims.clientInstanceId !== null &&
        claims.attachmentGeneration === null &&
        claims.controllerLeaseGeneration === null &&
        claims.deviceGeneration === null
      )
    case "device-challenge":
      return (
        claims.deviceId !== null &&
        claims.sessionId === null &&
        claims.clientInstanceId === null &&
        claims.attachmentGeneration === null &&
        claims.controllerLeaseGeneration === null &&
        claims.deviceGeneration === null
      )
    case "device-connect":
      return (
        claims.deviceId !== null &&
        claims.sessionId === null &&
        claims.clientInstanceId === null &&
        claims.attachmentGeneration === null &&
        claims.controllerLeaseGeneration === null &&
        claims.deviceGeneration !== null
      )
    case "session-tunnel":
      return (
        claims.deviceId !== null &&
        claims.sessionId !== null &&
        claims.clientInstanceId !== null &&
        claims.attachmentGeneration !== null &&
        claims.controllerLeaseGeneration !== null &&
        claims.deviceGeneration !== null
      )
  }
}

export type DeviceRelayGrantWindowRejection =
  | "expired"
  | "overlong"
  | "future-issued"

/** Shared lifetime checks; signature verification remains runtime-specific. */
export const deviceRelayGrantWindowRejection = (
  claims: Pick<DeviceRelayGrantClaims, "issuedAt" | "expiresAt">,
  nowSeconds: number
): DeviceRelayGrantWindowRejection | null =>
  claims.expiresAt <= nowSeconds
    ? "expired"
    : claims.expiresAt - claims.issuedAt > REMOTE_GRANT_MAX_TTL_SECONDS
      ? "overlong"
      : claims.issuedAt > nowSeconds + 60
        ? "future-issued"
        : null

export const DeviceRelayGrantRequest = Schema.Struct({
  version: Schema.Literal(REMOTE_PROTOCOL_VERSION),
  audience: Schema.Literal("device-control", "session-tunnel"),
  deviceId: Schema.NullOr(RemoteDeviceId),
  sessionId: Schema.NullOr(RemoteSessionId),
  clientInstanceId: Schema.optional(RemoteClientInstanceId),
  attachmentGeneration: Schema.optional(Schema.NullOr(Generation)),
  controllerLeaseGeneration: Schema.optional(Schema.NullOr(Generation))
})
export type DeviceRelayGrantRequest = Schema.Schema.Type<
  typeof DeviceRelayGrantRequest
>

export const DeviceRelayGrantResponse = Schema.Struct({
  version: Schema.Literal(REMOTE_PROTOCOL_VERSION),
  relayUrl: Schema.String.pipe(Schema.minLength(1)),
  grant: Schema.String.pipe(Schema.minLength(1)),
  claims: DeviceRelayGrantClaims
})
export type DeviceRelayGrantResponse = Schema.Schema.Type<
  typeof DeviceRelayGrantResponse
>

export const DeviceAttachmentGrant = DeviceRelayGrantResponse
export type DeviceAttachmentGrant = DeviceRelayGrantResponse

export const RelayUsage = Schema.Struct({
  version: Schema.Literal(DEVICE_REGISTRY_VERSION),
  accountId: Identity,
  deviceId: RemoteDeviceId,
  clientInstanceId: RemoteClientInstanceId,
  ciphertextBytesIn: Schema.Int.pipe(Schema.nonNegative()),
  ciphertextBytesOut: Schema.Int.pipe(Schema.nonNegative()),
  activeAttachments: Schema.Int.pipe(Schema.nonNegative()),
  quotaBytes: Schema.Int.pipe(Schema.nonNegative()),
  measuredAt: EpochSeconds
})
export type RelayUsage = Schema.Schema.Type<typeof RelayUsage>

/** Transport-independent relay limits shared by admission, metering, and clients. */
export const RELAY_USAGE_POLICY = {
  maximumFrameBytes: 1_100_000,
  maximumBufferedFrames: 256,
  maximumBufferedBytes: 8 * 1_024 * 1_024,
  handshakeTimeoutSeconds: 15,
  idleTimeoutSeconds: 5 * 60,
  maximumConcurrentClientsPerDevice: 8,
  maximumAttachmentAttemptsPerMinute: 60,
  /** Reserve usage in chunks so encrypted frames do not each wake the account ledger. */
  transferReservationBytes: 1 * 1_024 * 1_024,
  defaultAccountQuotaBytes: 10 * 1_024 * 1_024 * 1_024
} as const

export interface RelayUsageState {
  readonly ciphertextBytesIn: number
  readonly ciphertextBytesOut: number
  readonly activeAttachments: number
  readonly attachmentAttempts: number
  readonly attemptWindowStartedAt: number
}

export type RelayAdmission =
  | { readonly status: "admitted"; readonly next: RelayUsageState }
  | {
      readonly status: "quota-exceeded" | "rate-limited" | "concurrency-exceeded"
      readonly next: RelayUsageState
    }

export const emptyRelayUsage = (nowSeconds: number): RelayUsageState => ({
  ciphertextBytesIn: 0,
  ciphertextBytesOut: 0,
  activeAttachments: 0,
  attachmentAttempts: 0,
  attemptWindowStartedAt: nowSeconds
})

export const admitRelayAttachment = (
  state: RelayUsageState,
  nowSeconds: number,
  quotaBytes = RELAY_USAGE_POLICY.defaultAccountQuotaBytes
): RelayAdmission => {
  const resetWindow = nowSeconds - state.attemptWindowStartedAt >= 60
  const next = {
    ...state,
    attachmentAttempts: resetWindow ? 1 : state.attachmentAttempts + 1,
    attemptWindowStartedAt: resetWindow ? nowSeconds : state.attemptWindowStartedAt
  }
  if (next.attachmentAttempts > RELAY_USAGE_POLICY.maximumAttachmentAttemptsPerMinute) {
    return { status: "rate-limited", next }
  }
  if (state.ciphertextBytesIn + state.ciphertextBytesOut >= quotaBytes) {
    return { status: "quota-exceeded", next }
  }
  if (state.activeAttachments >= RELAY_USAGE_POLICY.maximumConcurrentClientsPerDevice) {
    return { status: "concurrency-exceeded", next }
  }
  return {
    status: "admitted",
    next: { ...next, activeAttachments: next.activeAttachments + 1 }
  }
}

export const recordRelayCiphertext = (
  state: RelayUsageState,
  direction: "in" | "out",
  bytes: number
): RelayUsageState => {
  if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > RELAY_USAGE_POLICY.maximumFrameBytes) {
    throw new RangeError("Relay ciphertext frame exceeds policy")
  }
  return direction === "in"
    ? { ...state, ciphertextBytesIn: state.ciphertextBytesIn + bytes }
    : { ...state, ciphertextBytesOut: state.ciphertextBytesOut + bytes }
}

export const releaseRelayAttachment = (state: RelayUsageState): RelayUsageState => ({
  ...state,
  activeAttachments: Math.max(0, state.activeAttachments - 1)
})

/** Quota never disables the control path used for status, cleanup, and revocation. */
export const allowRelayControlOperation = (): true => true

export const ClientAttachmentMode = Schema.Literal("passive", "controller")
export type ClientAttachmentMode = Schema.Schema.Type<
  typeof ClientAttachmentMode
>

export const ClientAttachment = Schema.Struct({
  version: Schema.Literal(CLIENT_ATTACHMENT_VERSION),
  attachmentId: OpaqueId,
  subject: Identity,
  deviceId: RemoteDeviceId,
  sessionId: RemoteSessionId,
  clientInstanceId: RemoteClientInstanceId,
  mode: ClientAttachmentMode,
  generation: Generation,
  controllerLeaseGeneration: Generation,
  attachedAt: EpochSeconds,
  expiresAt: EpochSeconds
})
export type ClientAttachment = Schema.Schema.Type<typeof ClientAttachment>

export const RemoteSessionInventoryEntry = Schema.Struct({
  version: Schema.Literal(REMOTE_SESSION_INVENTORY_VERSION),
  sessionId: RemoteSessionId,
  state: Schema.Literal("starting", "running", "idle", "completed", "failed"),
  controllerClientInstanceId: Schema.NullOr(RemoteClientInstanceId),
  controllerLeaseGeneration: Generation,
  updatedAt: EpochSeconds
})
export type RemoteSessionInventoryEntry = Schema.Schema.Type<
  typeof RemoteSessionInventoryEntry
>

export const RemoteSessionInventory = Schema.Struct({
  version: Schema.Literal(REMOTE_SESSION_INVENTORY_VERSION),
  deviceId: RemoteDeviceId,
  generatedAt: EpochSeconds,
  sessions: Schema.Array(RemoteSessionInventoryEntry).pipe(Schema.maxItems(256))
})
export type RemoteSessionInventory = Schema.Schema.Type<
  typeof RemoteSessionInventory
>

export const ControllerLease = Schema.Struct({
  version: Schema.Literal(CONTROLLER_LEASE_VERSION),
  subject: Identity,
  deviceId: RemoteDeviceId,
  sessionId: RemoteSessionId,
  ownerClientInstanceId: Schema.NullOr(RemoteClientInstanceId),
  generation: Generation,
  acquiredAt: Schema.NullOr(EpochSeconds),
  expiresAt: Schema.NullOr(EpochSeconds)
})
export type ControllerLease = Schema.Schema.Type<typeof ControllerLease>

export const ControllerLeaseRequest = Schema.Struct({
  version: Schema.Literal(CONTROLLER_LEASE_VERSION),
  clientInstanceId: RemoteClientInstanceId,
  expectedGeneration: Generation,
  takeover: Schema.Boolean
})
export type ControllerLeaseRequest = Schema.Schema.Type<
  typeof ControllerLeaseRequest
>

export const TunnelEndpoint = Schema.Literal("desktop", "device")
export type TunnelEndpoint = Schema.Schema.Type<typeof TunnelEndpoint>

/**
 * The relay's only persisted command/event payload. Encryption happens at the
 * endpoints; this schema deliberately has no prompt, output, path, or key field.
 */
export const EncryptedTunnelEnvelope = Schema.Struct({
  version: Schema.Literal(REMOTE_PROTOCOL_VERSION),
  sessionId: RemoteSessionId,
  sequence: Sequence,
  sender: TunnelEndpoint,
  algorithm: Schema.Literal("AES-256-GCM"),
  nonce: Base64Url.pipe(Schema.minLength(16), Schema.maxLength(64)),
  ciphertext: Base64Url.pipe(Schema.minLength(1), Schema.maxLength(1_000_000)),
  createdAt: EpochSeconds
})
export type EncryptedTunnelEnvelope = Schema.Schema.Type<
  typeof EncryptedTunnelEnvelope
>

export const TunnelAcknowledgement = Schema.Struct({
  version: Schema.Literal(REMOTE_PROTOCOL_VERSION),
  sessionId: RemoteSessionId,
  sender: TunnelEndpoint,
  acknowledgedSequence: Schema.Int.pipe(Schema.nonNegative())
})
export type TunnelAcknowledgement = Schema.Schema.Type<
  typeof TunnelAcknowledgement
>

export const TunnelClientMessage = Schema.Union(
  Schema.Struct({
    type: Schema.Literal("envelope"),
    envelope: EncryptedTunnelEnvelope
  }),
  Schema.Struct({
    type: Schema.Literal("ack"),
    acknowledgement: TunnelAcknowledgement
  }),
  Schema.Struct({
    type: Schema.Literal("resume"),
    acknowledgedSequence: Schema.Int.pipe(Schema.nonNegative())
  }),
  Schema.Struct({ type: Schema.Literal("ping") })
)
export type TunnelClientMessage = Schema.Schema.Type<typeof TunnelClientMessage>

/** Result of the device-owned git commit/push phase of remote publishing. */
export const RemotePublishPrepared = Schema.Struct({
  version: Schema.Literal(REMOTE_PROTOCOL_VERSION),
  sessionId: RemoteSessionId,
  githubSlug: Schema.String.pipe(
    Schema.pattern(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/, { identifier: "GitHubRepositorySlug" })
  ),
  branch: Schema.String.pipe(Schema.minLength(1), Schema.maxLength(512)),
  baseBranch: Schema.String.pipe(Schema.minLength(1), Schema.maxLength(512)),
  commitSha: Schema.String.pipe(
    Schema.pattern(/^[a-f0-9]{40,64}$/i, { identifier: "GitCommitSha" })
  ),
  commitMessage: Schema.String.pipe(Schema.minLength(1), Schema.maxLength(120)),
  prTitle: Schema.String.pipe(Schema.minLength(1), Schema.maxLength(256)),
  prBody: Schema.String.pipe(Schema.maxLength(65_536)),
  existingPrNumber: Schema.NullOr(Schema.Int.pipe(Schema.positive()))
})
export type RemotePublishPrepared = Schema.Schema.Type<typeof RemotePublishPrepared>

/** Desktop acknowledgement after GitHub creates or updates the PR by slug. */
export const RemotePublishCompleteInput = Schema.Struct({
  prNumber: Schema.Int.pipe(Schema.positive())
})
export type RemotePublishCompleteInput = Schema.Schema.Type<
  typeof RemotePublishCompleteInput
>

/** Plaintext exists only at the desktop/device endpoints before envelope encryption. */
export const RemoteSessionCommand = Schema.Struct({
  version: Schema.Literal(REMOTE_PROTOCOL_VERSION),
  commandId: OpaqueId,
  sessionId: RemoteSessionId,
  operation: Schema.String.pipe(Schema.minLength(1), Schema.maxLength(128)),
  payload: Schema.Unknown
})
export type RemoteSessionCommand = Schema.Schema.Type<typeof RemoteSessionCommand>

export const RemoteSessionKeyOffer = Schema.Struct({
  version: Schema.Literal(REMOTE_PROTOCOL_VERSION),
  sessionId: RemoteSessionId,
  deviceId: RemoteDeviceId,
  subject: Identity,
  ephemeralPublicKey: DeviceEncryptionPublicKey,
  salt: Base64Url.pipe(Schema.minLength(22), Schema.maxLength(64))
})
export type RemoteSessionKeyOffer = Schema.Schema.Type<typeof RemoteSessionKeyOffer>

/** First frame on an SSH-authenticated connection to the owned-device daemon. */
export const DirectSessionOpen = Schema.Struct({
  type: Schema.Literal("direct-open"),
  version: Schema.Literal(REMOTE_PROTOCOL_VERSION),
  sessionId: RemoteSessionId,
  acknowledgedSequence: Schema.Int.pipe(Schema.nonNegative()),
  keyOffer: RemoteSessionKeyOffer,
  clientInstanceId: RemoteClientInstanceId,
  attachmentGeneration: Generation,
  controllerLeaseGeneration: Generation
})
export type DirectSessionOpen = Schema.Schema.Type<typeof DirectSessionOpen>

export const RemoteSessionEvent = Schema.Struct({
  version: Schema.Literal(REMOTE_PROTOCOL_VERSION),
  commandId: OpaqueId,
  sessionId: RemoteSessionId,
  eventSequence: Schema.Int.pipe(Schema.nonNegative()),
  kind: Schema.Literal("event", "complete", "failed"),
  payload: Schema.Unknown
})
export type RemoteSessionEvent = Schema.Schema.Type<typeof RemoteSessionEvent>
