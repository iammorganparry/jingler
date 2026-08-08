import {
  RemoteSessionCommand as RemoteSessionCommandSchema,
  RemoteSessionKeyOffer as RemoteSessionKeyOfferSchema
} from "@jingler/core"
import {
  decryptRemotePayload,
  deriveDeviceSessionKey,
  encryptRemotePayload,
  openRemoteTunnel,
  RemoteSessionError
} from "@jingler/cli-adapters/remote-session"
import { Effect, Schema, Stream } from "effect"
import type { DeviceEnrollment } from "./control-connection.js"
import type { DeviceIdentity } from "./device-identity.js"
import type { SessionCommandHandler } from "./session-handler.js"

export interface DeviceSessionRequest {
  readonly relayUrl: string
  readonly sessionId: string
  readonly grant: string
  readonly keyOffer: unknown
}

/** Decrypts one session tunnel and dispatches admitted commands exactly once. */
export const runDeviceSessionTunnel = (
  request: DeviceSessionRequest,
  enrollment: DeviceEnrollment,
  identity: DeviceIdentity,
  handler: SessionCommandHandler
): Effect.Effect<void, RemoteSessionError> =>
  Effect.gen(function* () {
    const offer = yield* Schema.decodeUnknown(RemoteSessionKeyOfferSchema)(request.keyOffer).pipe(
      Effect.mapError((cause) => new RemoteSessionError({ message: "Invalid session key offer.", cause }))
    )
    const key = yield* Effect.try({
      try: () => deriveDeviceSessionKey(offer, identity.deriveSessionSecret, {
        subject: enrollment.subject,
        deviceId: enrollment.deviceId,
        sessionId: request.sessionId
      }),
      catch: (cause) => cause instanceof RemoteSessionError
        ? cause
        : new RemoteSessionError({ message: "Could not derive the session key.", cause })
    })
    const transport = yield* Effect.tryPromise({
      try: () => handler.transportState(),
      catch: (cause) => new RemoteSessionError({ message: "Could not restore device session transport state.", cause })
    })
    const tunnel = yield* openRemoteTunnel({
      relayUrl: request.relayUrl,
      grant: request.grant,
      sessionId: request.sessionId,
      endpoint: "device",
      acknowledgedSequence: transport.acknowledgedDesktopSequence
    })
    yield* tunnel.events.pipe(
      Stream.filter((envelope) => envelope.sender === "desktop"),
      Stream.runForEach((envelope) =>
        Effect.gen(function* () {
          const command = yield* Effect.try({
            try: () => decryptRemotePayload(key, envelope, RemoteSessionCommandSchema),
            catch: (cause) => cause instanceof RemoteSessionError
              ? cause
              : new RemoteSessionError({ message: "Invalid remote command.", cause })
          })
          const events = yield* Effect.tryPromise({
            try: () => handler.handle(command, envelope.sequence),
            catch: (cause) => new RemoteSessionError({ message: "Remote command dispatch failed.", cause })
          })
          const outgoing = yield* Effect.tryPromise({
            try: () => handler.prepareOutgoingEnvelopes(
              command.commandId,
              (event, sequence) => encryptRemotePayload(key, request.sessionId, sequence, "device", event)
            ),
            catch: (cause) => new RemoteSessionError({ message: "Could not persist remote event sequences.", cause })
          })
          for (const eventEnvelope of outgoing) {
            yield* tunnel.send(eventEnvelope)
          }
          // handle() persists the incoming cursor and prepareOutgoingEnvelopes()
          // persists every response envelope before this acknowledgement.
          yield* tunnel.acknowledge(envelope.sequence)
        })
      ),
      Effect.ensuring(tunnel.close)
    )
  })
