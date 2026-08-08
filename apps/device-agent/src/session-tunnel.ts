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
  Effect.scoped(Effect.gen(function* () {
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
    const outgoingGate = yield* Effect.makeSemaphore(1)
    const flushCommand = (commandId: string) => outgoingGate.withPermits(1)(
      Effect.gen(function* () {
        const outgoing = yield* Effect.tryPromise({
          try: () => handler.prepareOutgoingEnvelopes(
            commandId,
            (event, sequence) =>
              encryptRemotePayload(key, request.sessionId, sequence, "device", event)
          ),
          catch: (cause) => new RemoteSessionError({
            message: "Could not persist remote event sequences.",
            cause
          })
        })
        const relayNextSequence = yield* tunnel.nextOutgoingSequence
        const unsent = outgoing.filter(
          (eventEnvelope) => eventEnvelope.sequence >= relayNextSequence
        )
        if (unsent[0] && unsent[0].sequence !== relayNextSequence) {
          return yield* Effect.fail(new RemoteSessionError({
            message: `Device event sequence gap: relay expects ${relayNextSequence}, local state has ${unsent[0].sequence}.`
          }))
        }
        for (const eventEnvelope of unsent) yield* tunnel.send(eventEnvelope)
        const persisted = yield* Effect.tryPromise({
          try: () => handler.transportState(),
          catch: (cause) => new RemoteSessionError({
            message: "Could not restore device session transport state.",
            cause
          })
        })
        yield* tunnel.acknowledge(persisted.acknowledgedDesktopSequence)
      })
    )
    // Relay confirmation from the desktop is the only safe point at which the
    // device can discard persisted response ciphertext. This runs independently
    // from command dispatch so a long Agent.run cannot block pruning.
    yield* Effect.forkScoped(
      tunnel.peerAcknowledgements.pipe(
        Stream.runForEach((sequence) =>
          Effect.tryPromise({
            try: () => handler.acknowledgeOutgoing(sequence),
            catch: (cause) => new RemoteSessionError({
              message: "Could not prune acknowledged remote responses.",
              cause
            })
          })
        )
      )
    )
    yield* tunnel.events.pipe(
      Stream.filter((envelope) => envelope.sender === "desktop"),
      Stream.mapEffect((envelope) =>
        Effect.gen(function* () {
          const command = yield* Effect.try({
            try: () => decryptRemotePayload(key, envelope, RemoteSessionCommandSchema),
            catch: (cause) => cause instanceof RemoteSessionError
              ? cause
              : new RemoteSessionError({ message: "Invalid remote command.", cause })
          })
          yield* Effect.tryPromise({
            try: () => handler.handle(
              command,
              envelope.sequence,
              (commandId) => Effect.runPromise(flushCommand(commandId))
            ),
            catch: (cause) => new RemoteSessionError({ message: "Remote command dispatch failed.", cause })
          })
          // Replays of already-settled commands do not emit again, so flush the
          // persisted ciphertext once after handle() as well.
          yield* flushCommand(command.commandId)
        }),
        { concurrency: "unbounded" }
      ),
      Stream.runDrain,
      Effect.ensuring(tunnel.close)
    )
  }))
