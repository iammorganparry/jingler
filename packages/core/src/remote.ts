import { Schema } from "effect"
import { CliKind } from "./domain.js"

/** Wire revision shared by the server, relay Worker, desktop, and device daemon. */
export const REMOTE_PROTOCOL_VERSION = 1 as const
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
  "session.observe"
)
export type RemoteDeviceCapability = Schema.Schema.Type<
  typeof RemoteDeviceCapability
>

/** Bounded, declarative device features used for scheduling and UI affordances. */
export const RemoteDeviceCapabilities = Schema.Struct({
  version: Schema.Literal(REMOTE_PROTOCOL_VERSION),
  capabilities: Schema.Array(RemoteDeviceCapability).pipe(Schema.maxItems(16)),
  harnesses: Schema.Array(CliKind).pipe(Schema.maxItems(16)),
  maxConcurrentSessions: Schema.Int.pipe(Schema.between(1, 64))
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
  capabilities: RemoteDeviceCapabilities
})
export type PendingDeviceRegistrationRequest = Schema.Schema.Type<
  typeof PendingDeviceRegistrationRequest
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
  version: Schema.Literal(REMOTE_PROTOCOL_VERSION),
  issuer: Schema.Literal("jingler"),
  audience: DeviceRelayGrantAudience,
  subject: Identity,
  deviceId: Schema.NullOr(RemoteDeviceId),
  sessionId: Schema.NullOr(RemoteSessionId),
  deviceGeneration: Schema.NullOr(Generation),
  issuedAt: EpochSeconds,
  expiresAt: EpochSeconds,
  grantId: OpaqueId
})
export type DeviceRelayGrantClaims = Schema.Schema.Type<
  typeof DeviceRelayGrantClaims
>

export const DeviceRelayGrantRequest = Schema.Struct({
  version: Schema.Literal(REMOTE_PROTOCOL_VERSION),
  audience: Schema.Literal("device-control", "session-tunnel"),
  deviceId: Schema.NullOr(RemoteDeviceId),
  sessionId: Schema.NullOr(RemoteSessionId)
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

export const RemoteSessionEvent = Schema.Struct({
  version: Schema.Literal(REMOTE_PROTOCOL_VERSION),
  commandId: OpaqueId,
  sessionId: RemoteSessionId,
  eventSequence: Schema.Int.pipe(Schema.nonNegative()),
  kind: Schema.Literal("event", "complete", "failed"),
  payload: Schema.Unknown
})
export type RemoteSessionEvent = Schema.Schema.Type<typeof RemoteSessionEvent>
