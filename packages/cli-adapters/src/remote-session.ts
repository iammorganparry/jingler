import { createCipheriv, createDecipheriv, createPrivateKey, createPublicKey, diffieHellman, generateKeyPairSync, hkdfSync, randomBytes } from "node:crypto"
import type { DeviceEncryptionPublicKey, EncryptedTunnelEnvelope, RemoteSessionCommand, RemoteSessionEvent, RemoteSessionKeyOffer, Session } from "@jingler/core"
import { EncryptedTunnelEnvelope as EncryptedTunnelEnvelopeSchema, RemoteSessionEvent as RemoteSessionEventSchema } from "@jingler/core"
import { Chunk, Data, Effect, Either, Queue, Schema, Stream } from "effect"
import WebSocket from "ws"
import { EnvironmentService } from "./environment.js"
import { SecretStore, type SecretStoreShape } from "./secret-store.js"

export class RemoteSessionError extends Data.TaggedError("RemoteSessionError")<{
  readonly message: string
  readonly cause?: unknown
}> {}

const sessionInfo = (subject: string, deviceId: string, sessionId: string) =>
  Buffer.from(`jingler.remote.session.v1\0${subject}\0${deviceId}\0${sessionId}`, "utf8")

const x25519PublicKey = (value: DeviceEncryptionPublicKey) =>
  createPublicKey({ key: { kty: "OKP", crv: "X25519", x: value.value }, format: "jwk" })

export const establishDesktopSessionKey = (input: {
  readonly subject: string
  readonly deviceId: string
  readonly sessionId: string
  readonly devicePublicKey: DeviceEncryptionPublicKey
}): { readonly offer: RemoteSessionKeyOffer; readonly key: Uint8Array; readonly privateKey: string } => {
  const ephemeral = generateKeyPairSync("x25519")
  const jwk = ephemeral.publicKey.export({ format: "jwk" })
  if (jwk.crv !== "X25519" || typeof jwk.x !== "string") throw new RemoteSessionError({ message: "Invalid ephemeral X25519 key." })
  const salt = randomBytes(32)
  const secret = diffieHellman({ privateKey: ephemeral.privateKey, publicKey: x25519PublicKey(input.devicePublicKey) })
  const privateJwk = ephemeral.privateKey.export({ format: "jwk" })
  return {
    offer: { version: 1, sessionId: input.sessionId, deviceId: input.deviceId, subject: input.subject, ephemeralPublicKey: { algorithm: "X25519", encoding: "base64url", value: jwk.x }, salt: salt.toString("base64url") },
    key: new Uint8Array(hkdfSync("sha256", secret, salt, sessionInfo(input.subject, input.deviceId, input.sessionId), 32)),
    privateKey: Buffer.from(JSON.stringify(privateJwk), "utf8").toString("base64url")
  }
}

export const restoreDesktopSessionKey = (input: {
  readonly offer: RemoteSessionKeyOffer
  readonly privateKey: string
  readonly devicePublicKey: DeviceEncryptionPublicKey
}): Uint8Array => {
  try {
    const privateKey = createPrivateKey({
      key: JSON.parse(Buffer.from(input.privateKey, "base64url").toString("utf8")),
      format: "jwk"
    })
    const secret = diffieHellman({ privateKey, publicKey: x25519PublicKey(input.devicePublicKey) })
    return new Uint8Array(hkdfSync(
      "sha256",
      secret,
      Buffer.from(input.offer.salt, "base64url"),
      sessionInfo(input.offer.subject, input.offer.deviceId, input.offer.sessionId),
      32
    ))
  } catch (cause) {
    throw new RemoteSessionError({ message: "Could not restore the encrypted remote session.", cause })
  }
}

export const deriveDeviceSessionKey = (
  offer: RemoteSessionKeyOffer,
  deriveSecret: (publicKey: DeviceEncryptionPublicKey) => Uint8Array,
  expected: { readonly subject: string; readonly deviceId: string; readonly sessionId: string }
): Uint8Array => {
  if (offer.subject !== expected.subject || offer.deviceId !== expected.deviceId || offer.sessionId !== expected.sessionId) {
    throw new RemoteSessionError({ message: "Session key offer resource mismatch." })
  }
  return new Uint8Array(hkdfSync("sha256", deriveSecret(offer.ephemeralPublicKey), Buffer.from(offer.salt, "base64url"), sessionInfo(offer.subject, offer.deviceId, offer.sessionId), 32))
}

const aad = (sessionId: string, sequence: number, sender: "desktop" | "device") =>
  Buffer.from(`jingler.remote.v1.${sessionId}.${sequence}.${sender}`, "utf8")

export const encryptRemotePayload = (
  key: Uint8Array,
  sessionId: string,
  sequence: number,
  sender: "desktop" | "device",
  payload: unknown,
  createdAt = Math.floor(Date.now() / 1000)
): EncryptedTunnelEnvelope => {
  if (key.byteLength !== 32) throw new RemoteSessionError({ message: "Session key must be 32 bytes." })
  const nonce = randomBytes(12)
  const cipher = createCipheriv("aes-256-gcm", key, nonce)
  cipher.setAAD(aad(sessionId, sequence, sender))
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(payload), "utf8"), cipher.final()])
  return {
    version: 1,
    sessionId,
    sequence,
    sender,
    algorithm: "AES-256-GCM",
    nonce: nonce.toString("base64url"),
    ciphertext: Buffer.concat([encrypted, cipher.getAuthTag()]).toString("base64url"),
    createdAt
  }
}

export const decryptRemotePayload = <A, I>(
  key: Uint8Array,
  envelope: EncryptedTunnelEnvelope,
  schema: Schema.Schema<A, I>
): A => {
  try {
    const nonce = Buffer.from(envelope.nonce, "base64url")
    const combined = Buffer.from(envelope.ciphertext, "base64url")
    const ciphertext = combined.subarray(0, combined.length - 16)
    const tag = combined.subarray(combined.length - 16)
    const decipher = createDecipheriv("aes-256-gcm", key, nonce)
    decipher.setAAD(aad(envelope.sessionId, envelope.sequence, envelope.sender))
    decipher.setAuthTag(tag)
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8")
    return Schema.decodeUnknownSync(schema)(JSON.parse(plaintext), { onExcessProperty: "error" })
  } catch (cause) {
    throw new RemoteSessionError({ message: "Remote envelope authentication failed.", cause })
  }
}

export interface RemoteTunnel {
  readonly send: (envelope: EncryptedTunnelEnvelope) => Effect.Effect<void, RemoteSessionError>
  readonly events: Stream.Stream<EncryptedTunnelEnvelope, RemoteSessionError>
  readonly acknowledge: (sequence: number) => Effect.Effect<void, RemoteSessionError>
  readonly isOpen: () => boolean
}

export interface OpenRemoteTunnelInput {
  readonly relayUrl: string
  readonly grant: string
  readonly sessionId: string
  readonly endpoint: "desktop" | "device"
  readonly acknowledgedSequence: number
  readonly keyOffer?: RemoteSessionKeyOffer
}

const tunnelUrl = (input: OpenRemoteTunnelInput): string => {
  const url = new URL(`/v1/session-tunnels/${encodeURIComponent(input.sessionId)}`, input.relayUrl)
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:"
  url.searchParams.set("endpoint", input.endpoint)
  url.searchParams.set("acknowledgedSequence", String(input.acknowledgedSequence))
  if (input.keyOffer) {
    url.searchParams.set(
      "keyOffer",
      Buffer.from(JSON.stringify(input.keyOffer), "utf8").toString("base64url")
    )
  }
  return url.toString()
}

/** A typed endpoint for the relay. Payloads are still opaque ciphertext here. */
export const openRemoteTunnel = (
  input: OpenRemoteTunnelInput
): Effect.Effect<RemoteTunnel & { readonly close: Effect.Effect<void> }, RemoteSessionError> =>
  Effect.gen(function* () {
    const envelopes = yield* Queue.unbounded<EncryptedTunnelEnvelope>()
    const pendingWrites = new Map<number, { readonly resolve: () => void; readonly reject: (cause: RemoteSessionError) => void }>()
    const socket = yield* Effect.async<WebSocket, RemoteSessionError>((resume) => {
      const candidate = new WebSocket(tunnelUrl(input), {
        headers: { authorization: `Bearer ${input.grant}` }
      })
      const onError = (cause: Error) => {
        candidate.close()
        resume(Effect.fail(new RemoteSessionError({ message: "Remote tunnel connection failed.", cause })))
      }
      candidate.once("error", onError)
      candidate.once("open", () => {
        candidate.off("error", onError)
        resume(Effect.succeed(candidate))
      })
      return Effect.sync(() => candidate.close())
    })
    socket.on("message", (data) => {
      try {
        const value: unknown = JSON.parse(data.toString("utf8"))
        if (value && typeof value === "object" && (value as { type?: unknown }).type === "envelope-result") {
          const result = value as { sequence?: unknown; status?: unknown }
          if (typeof result.sequence === "number") {
            const pending = pendingWrites.get(result.sequence)
            if (pending && (result.status === "inserted" || result.status === "duplicate")) {
              pendingWrites.delete(result.sequence)
              pending.resolve()
            } else if (pending) {
              pendingWrites.delete(result.sequence)
              pending.reject(new RemoteSessionError({ message: `Relay rejected sequence ${result.sequence}: ${String(result.status)}.` }))
            }
          }
          return
        }
        if (!value || typeof value !== "object" || (value as { type?: unknown }).type !== "envelope") return
        const decoded = Schema.decodeUnknownEither(EncryptedTunnelEnvelopeSchema)(
          (value as { envelope?: unknown }).envelope,
          { onExcessProperty: "error" }
        )
        if (Either.isRight(decoded)) void Effect.runPromise(Queue.offer(envelopes, decoded.right))
      } catch {
        // Relay control frames and malformed values cannot become application events.
      }
    })
    socket.once("close", () => {
      const error = new RemoteSessionError({ message: "Remote tunnel closed." })
      for (const pending of pendingWrites.values()) pending.reject(error)
      pendingWrites.clear()
      void Effect.runPromise(Queue.shutdown(envelopes))
    })
    const sendJson = (value: unknown) =>
      Effect.try({
        try: () => socket.send(JSON.stringify(value)),
        catch: (cause) => new RemoteSessionError({ message: "Remote tunnel write failed.", cause })
      }).pipe(Effect.asVoid)
    return {
      send: (envelope) => Effect.async<void, RemoteSessionError>((resume) => {
        if (socket.readyState !== WebSocket.OPEN) {
          resume(Effect.fail(new RemoteSessionError({ message: "Remote tunnel is not open." })))
          return
        }
        pendingWrites.set(envelope.sequence, {
          resolve: () => resume(Effect.void),
          reject: (cause) => resume(Effect.fail(cause))
        })
        try {
          socket.send(JSON.stringify({ type: "envelope", envelope }))
        } catch (cause) {
          pendingWrites.delete(envelope.sequence)
          resume(Effect.fail(new RemoteSessionError({ message: "Remote tunnel write failed.", cause })))
        }
        return Effect.sync(() => pendingWrites.delete(envelope.sequence))
      }),
      events: Stream.fromQueue(envelopes),
      acknowledge: (acknowledgedSequence) => sendJson({
        type: "ack",
        acknowledgement: {
          version: 1,
          sessionId: input.sessionId,
          sender: input.endpoint,
          acknowledgedSequence
        }
      }),
      isOpen: () => socket.readyState === WebSocket.OPEN,
      close: Effect.sync(() => socket.close(1000, "Tunnel closed"))
    }
  })

export interface DesktopRemoteSessionState {
  readonly version: 1
  readonly sessionId: string
  readonly deviceId: string
  readonly subject: string
  readonly devicePublicKey: DeviceEncryptionPublicKey
  readonly offer: RemoteSessionKeyOffer
  readonly ephemeralPrivateKey: string
  readonly nextOutgoingSequence: number
  readonly acknowledgedDeviceSequence: number
  readonly pendingCommand: null | {
    readonly command: RemoteSessionCommand
    readonly envelope: EncryptedTunnelEnvelope
  }
}

interface DeviceSecretDocument {
  readonly remoteSessions?: Readonly<Record<string, DesktopRemoteSessionState>>
  readonly [key: string]: unknown
}

const decodeSecretDocument = (raw: string | null): DeviceSecretDocument => {
  if (!raw) return {}
  try {
    const value: unknown = JSON.parse(raw)
    return value && typeof value === "object" && !Array.isArray(value)
      ? Object.fromEntries(Object.entries(value))
      : {}
  } catch {
    return {}
  }
}

const isRemoteSessionState = (value: unknown): value is DesktopRemoteSessionState => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  const record = Object.fromEntries(Object.entries(value))
  return record.version === 1 &&
    typeof record.sessionId === "string" &&
    typeof record.deviceId === "string" &&
    typeof record.subject === "string" &&
    typeof record.ephemeralPrivateKey === "string" &&
    Number.isInteger(record.nextOutgoingSequence) &&
    Number.isInteger(record.acknowledgedDeviceSequence) &&
    record.offer !== undefined &&
    record.devicePublicKey !== undefined
}

export interface RemoteSessionStateRepository {
  readonly get: (sessionId: string) => Effect.Effect<DesktopRemoteSessionState | null, RemoteSessionError>
  readonly put: (state: DesktopRemoteSessionState) => Effect.Effect<void, RemoteSessionError>
}

/** Serialises read/modify/write so independent remote sessions cannot clobber one another. */
export const makeRemoteSessionStateRepository = (
  secrets: SecretStoreShape
): RemoteSessionStateRepository => {
  let serial: Promise<unknown> = Promise.resolve()
  const transact = <A>(operation: () => Promise<A>): Effect.Effect<A, RemoteSessionError> =>
    Effect.tryPromise({
      try: () => {
        const pending = serial.then(operation)
        serial = pending.catch(() => undefined)
        return pending
      },
      catch: (cause) => new RemoteSessionError({ message: "Could not persist encrypted remote session state.", cause })
    })
  return {
    get: (sessionId) => transact(async () => {
      const document = decodeSecretDocument(await Effect.runPromise(secrets.getDeviceSecrets))
      const candidate = document.remoteSessions?.[sessionId]
      return isRemoteSessionState(candidate) ? candidate : null
    }),
    put: (state) => transact(async () => {
      const document = decodeSecretDocument(await Effect.runPromise(secrets.getDeviceSecrets))
      await Effect.runPromise(secrets.setDeviceSecrets(JSON.stringify({
        ...document,
        remoteSessions: { ...document.remoteSessions, [state.sessionId]: state }
      })))
    })
  }
}

interface ActiveRemoteSession {
  readonly key: Uint8Array
  readonly tunnel: RemoteTunnel & { readonly close: Effect.Effect<void> }
}
type RemoteSessionResource = Pick<Session, "id" | "environmentId">

/** Main-process owner of encrypted remote tunnels. It never falls back locally. */
export class RemoteSessionService extends Effect.Service<RemoteSessionService>()(
  "@jingler/RemoteSessionService",
  {
    accessors: true,
    effect: Effect.gen(function* () {
      const environments = yield* EnvironmentService
      const secrets = yield* SecretStore
      const states = makeRemoteSessionStateRepository(secrets)
      const active = new Map<string, Promise<ActiveRemoteSession>>()

      const establish = (session: RemoteSessionResource): Effect.Effect<ActiveRemoteSession, RemoteSessionError> =>
        Effect.tryPromise({
          try: async () => {
            if (!session.environmentId) throw new RemoteSessionError({ message: "Remote session has no device identity." })
            const environmentId = session.environmentId
            const existing = active.get(session.id)
            if (existing) {
              const connection = await existing
              if (connection.tunnel.isOpen()) return connection
              active.delete(session.id)
              await Effect.runPromise(connection.tunnel.close)
            }
            const pending = Effect.runPromise(
              Effect.gen(function* () {
                const device = yield* environments.device(environmentId).pipe(
                  Effect.mapError((cause) => new RemoteSessionError({ message: cause.message, cause }))
                )
                if (!device.encryptionPublicKey) {
                  return yield* Effect.fail(new RemoteSessionError({
                    message: "The paired device must upgrade before it can run encrypted sessions."
                  }))
                }
                const grant = yield* environments.sessionGrant(device.deviceId, session.id).pipe(
                  Effect.mapError((cause) => new RemoteSessionError({ message: cause.message, cause }))
                )
                const restored = yield* states.get(session.id)
                const state = restored &&
                  restored.subject === grant.claims.subject &&
                  restored.deviceId === device.deviceId &&
                  restored.devicePublicKey.value === device.encryptionPublicKey.value
                  ? restored
                  : (() => {
                      const established = establishDesktopSessionKey({
                        subject: grant.claims.subject,
                        deviceId: device.deviceId,
                        sessionId: session.id,
                        devicePublicKey: device.encryptionPublicKey
                      })
                      return {
                        version: 1 as const,
                        sessionId: session.id,
                        deviceId: device.deviceId,
                        subject: grant.claims.subject,
                        devicePublicKey: device.encryptionPublicKey,
                        offer: established.offer,
                        ephemeralPrivateKey: established.privateKey,
                        nextOutgoingSequence: 1,
                        acknowledgedDeviceSequence: 0,
                        pendingCommand: null
                      }
                    })()
                yield* states.put(state)
                const key = restoreDesktopSessionKey({
                  offer: state.offer,
                  privateKey: state.ephemeralPrivateKey,
                  devicePublicKey: state.devicePublicKey
                })
                const tunnel = yield* openRemoteTunnel({
                  relayUrl: grant.relayUrl,
                  grant: grant.grant,
                  sessionId: session.id,
                  endpoint: "desktop",
                  acknowledgedSequence: state.acknowledgedDeviceSequence,
                  keyOffer: state.offer
                })
                return { key, tunnel }
              })
            )
            active.set(session.id, pending)
            try {
              return await pending
            } catch (error) {
              active.delete(session.id)
              throw error
            }
          },
          catch: (cause) => cause instanceof RemoteSessionError
            ? cause
            : new RemoteSessionError({ message: "Could not establish the remote session.", cause })
        })

      const prepareCommand = (
        session: RemoteSessionResource,
        operation: string,
        payload: unknown,
        key: Uint8Array
      ) => Effect.gen(function* () {
        const state = yield* states.get(session.id)
        if (!state) return yield* Effect.fail(new RemoteSessionError({ message: "Remote session key state is unavailable." }))
        if (state.pendingCommand) return state.pendingCommand
        const command: RemoteSessionCommand = {
          version: 1,
          commandId: randomBytes(18).toString("base64url"),
          sessionId: session.id,
          operation,
          payload
        }
        const pendingCommand = {
          command,
          envelope: encryptRemotePayload(key, session.id, state.nextOutgoingSequence, "desktop", command)
        }
        yield* states.put({ ...state, pendingCommand })
        return pendingCommand
      })

      type Output =
        | { readonly _tag: "event"; readonly event: RemoteSessionEvent }
        | { readonly _tag: "error"; readonly error: RemoteSessionError }

      const execute = (session: RemoteSessionResource, operation: string, payload: unknown) =>
        Stream.unwrapScoped(
          Effect.gen(function* () {
            const output = yield* Queue.unbounded<Output>()
            yield* Effect.forkScoped(
              Effect.gen(function* () {
                let terminal = false
                let failures = 0
                while (!terminal) {
                  const established = yield* establish(session).pipe(Effect.either)
                  if (Either.isLeft(established)) {
                    active.delete(session.id)
                    failures += 1
                    if (failures >= 5) return yield* Effect.fail(established.left)
                    yield* Effect.sleep(Math.min(2_000, 50 * 2 ** failures))
                    continue
                  }
                  const connection = established.right
                  const pending = yield* prepareCommand(session, operation, payload, connection.key)
                  const beforeSend = yield* states.get(session.id)
                  if (!beforeSend) return yield* Effect.fail(new RemoteSessionError({ message: "Remote session key state is unavailable." }))
                  const sent = yield* connection.tunnel.send(pending.envelope).pipe(Effect.either)
                  if (Either.isLeft(sent)) {
                    active.delete(session.id)
                    yield* connection.tunnel.close
                    failures += 1
                    if (failures >= 5) return yield* Effect.fail(sent.left)
                    yield* Effect.sleep(Math.min(2_000, 50 * 2 ** failures))
                    continue
                  }
                  if (beforeSend.nextOutgoingSequence === pending.envelope.sequence) {
                    yield* states.put({ ...beforeSend, nextOutgoingSequence: pending.envelope.sequence + 1 })
                  }
                  const ended = yield* connection.tunnel.events.pipe(
                    Stream.filter((envelope) => envelope.sender === "device"),
                    Stream.runForEach((envelope) => Effect.gen(function* () {
                      const current = yield* states.get(session.id)
                      if (!current) return yield* Effect.fail(new RemoteSessionError({ message: "Remote session key state is unavailable." }))
                      if (envelope.sequence <= current.acknowledgedDeviceSequence) {
                        yield* connection.tunnel.acknowledge(current.acknowledgedDeviceSequence)
                        return
                      }
                      if (envelope.sequence !== current.acknowledgedDeviceSequence + 1) {
                        return yield* Effect.fail(new RemoteSessionError({ message: `Remote event sequence gap: expected ${current.acknowledgedDeviceSequence + 1}, received ${envelope.sequence}.` }))
                      }
                      const event = yield* Effect.try({
                        try: () => decryptRemotePayload(connection.key, envelope, RemoteSessionEventSchema),
                        catch: (cause) => cause instanceof RemoteSessionError
                          ? cause
                          : new RemoteSessionError({ message: "Invalid remote event.", cause })
                      })
                      const isTerminal = event.commandId === pending.command.commandId &&
                        (event.kind === "complete" || event.kind === "failed")
                      yield* states.put({
                        ...current,
                        acknowledgedDeviceSequence: envelope.sequence,
                        pendingCommand: isTerminal ? null : current.pendingCommand
                      })
                      yield* connection.tunnel.acknowledge(envelope.sequence)
                      if (event.commandId === pending.command.commandId) {
                        yield* Queue.offer(output, { _tag: "event", event })
                        terminal = isTerminal
                        if (isTerminal) yield* connection.tunnel.close
                      }
                    }))).pipe(Effect.either)
                  if (Either.isLeft(ended)) {
                    active.delete(session.id)
                    yield* connection.tunnel.close
                    failures += 1
                    if (failures >= 5) return yield* Effect.fail(ended.left)
                    yield* Effect.sleep(Math.min(2_000, 50 * 2 ** failures))
                  } else if (!terminal) {
                    active.delete(session.id)
                    failures += 1
                    yield* Effect.sleep(Math.min(2_000, 50 * 2 ** failures))
                  }
                }
              }).pipe(
                Effect.catchAll((error) => Queue.offer(output, { _tag: "error", error })),
                Effect.ensuring(Queue.shutdown(output))
              )
            )
            return Stream.fromQueue(output).pipe(
              Stream.mapEffect((item) => item._tag === "event" ? Effect.succeed(item.event) : Effect.fail(item.error))
            )
          })
        )

      const request = (session: RemoteSessionResource, operation: string, payload: unknown) =>
        execute(session, operation, payload).pipe(
          Stream.runCollect,
          Effect.flatMap((chunk) => {
            const events = Chunk.toReadonlyArray(chunk)
            const failed = events.find((event) => event.kind === "failed")
            if (failed) {
              const message = failed.payload && typeof failed.payload === "object" &&
                "message" in failed.payload && typeof failed.payload.message === "string"
                ? failed.payload.message
                : `Remote operation ${operation} failed.`
              return Effect.fail(new RemoteSessionError({ message }))
            }
            const complete = events.findLast((event) => event.kind === "complete")
            return complete
              ? Effect.succeed(complete.payload)
              : Effect.fail(new RemoteSessionError({
                  message: `Remote operation ${operation} ended without a completion.`
                }))
          })
        )

      const requestOnEnvironment = (
        environmentId: string,
        operation: string,
        payload: unknown
      ) => request(
        {
          id: `request_${randomBytes(18).toString("base64url")}`,
          environmentId
        },
        operation,
        payload
      )

      return { execute, request, requestOnEnvironment } as const
    })
  }
) {}
