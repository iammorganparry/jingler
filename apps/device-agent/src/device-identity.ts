import {
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  sign as nodeSign,
  type KeyObject
} from "node:crypto"
import { chmod, mkdir, open, readFile, rename, rm, writeFile } from "node:fs/promises"
import { dirname } from "node:path"
import type { DeviceChallenge, DeviceEncryptionPublicKey, DevicePublicKey } from "@jingler/core"
import { deviceChallengePayload } from "@jingler/core"
import { Data, Effect } from "effect"

export class DeviceIdentityError extends Data.TaggedError("DeviceIdentityError")<{
  readonly message: string
  readonly cause?: unknown
}> {}

interface StoredDeviceIdentity {
  readonly version: 1
  readonly algorithm: "Ed25519"
  readonly publicKey: DevicePublicKey
  readonly privateKeyPkcs8: string
  readonly encryptionPublicKey: DeviceEncryptionPublicKey
  readonly encryptionPrivateKeyPkcs8: string
}

interface LegacyStoredDeviceIdentity {
  readonly version: 1
  readonly algorithm: "Ed25519"
  readonly publicKey: DevicePublicKey
  readonly privateKeyPkcs8: string
}

export interface DeviceIdentity {
  readonly publicKey: DevicePublicKey
  readonly encryptionPublicKey: DeviceEncryptionPublicKey
  readonly deriveSessionSecret: (ephemeralPublicKey: DeviceEncryptionPublicKey) => Uint8Array
  readonly sign: (payload: Uint8Array) => string
  readonly signChallenge: (challenge: DeviceChallenge, newPublicKey?: DevicePublicKey) => string
}

const base64Url = (value: Uint8Array): string => Buffer.from(value).toString("base64url")

const publicKeyOf = (key: KeyObject): DevicePublicKey => {
  const jwk = key.export({ format: "jwk" })
  if (jwk.kty !== "OKP" || jwk.crv !== "Ed25519" || typeof jwk.x !== "string") {
    throw new Error("Generated key is not Ed25519")
  }
  return { algorithm: "Ed25519", encoding: "base64url", value: jwk.x }
}

const encryptionPublicKeyOf = (key: KeyObject): DeviceEncryptionPublicKey => {
  const jwk = key.export({ format: "jwk" })
  if (jwk.kty !== "OKP" || jwk.crv !== "X25519" || typeof jwk.x !== "string") throw new Error("Generated key is not X25519")
  return { algorithm: "X25519", encoding: "base64url", value: jwk.x }
}

const x25519PublicKey = (value: DeviceEncryptionPublicKey): KeyObject =>
  createPublicKey({ key: { kty: "OKP", crv: "X25519", x: value.value }, format: "jwk" })

const identityFromStored = (stored: StoredDeviceIdentity): DeviceIdentity => {
  if (
    stored.version !== 1 ||
    stored.algorithm !== "Ed25519" ||
    stored.publicKey.algorithm !== "Ed25519" ||
    stored.publicKey.encoding !== "base64url"
  ) {
    throw new Error("Unsupported device identity")
  }
  const privateKey = createPrivateKey({
    key: Buffer.from(stored.privateKeyPkcs8, "base64"),
    format: "der",
    type: "pkcs8"
  })
  const derived = publicKeyOf(createPublicKey(privateKey))
  if (derived.value !== stored.publicKey.value) throw new Error("Device identity key mismatch")
  const sign = (payload: Uint8Array): string => base64Url(nodeSign(null, payload, privateKey))
  const encryptionPrivateKey = createPrivateKey({ key: Buffer.from(stored.encryptionPrivateKeyPkcs8, "base64"), format: "der", type: "pkcs8" })
  if (encryptionPublicKeyOf(createPublicKey(encryptionPrivateKey)).value !== stored.encryptionPublicKey.value) throw new Error("Device encryption key mismatch")
  return {
    publicKey: stored.publicKey,
    encryptionPublicKey: stored.encryptionPublicKey,
    deriveSessionSecret: (ephemeralPublicKey) => new Uint8Array(diffieHellman({ privateKey: encryptionPrivateKey, publicKey: x25519PublicKey(ephemeralPublicKey) })),
    sign,
    signChallenge: (challenge, newPublicKey) =>
      sign(deviceChallengePayload(challenge, newPublicKey))
  }
}

const parseStored = (raw: string): StoredDeviceIdentity | LegacyStoredDeviceIdentity => {
  const value: unknown = JSON.parse(raw)
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Malformed device identity")
  }
  const record = Object.fromEntries(Object.entries(value))
  if (
    record.version !== 1 ||
    record.algorithm !== "Ed25519" ||
    typeof record.privateKeyPkcs8 !== "string" ||
    !record.publicKey ||
    typeof record.publicKey !== "object" ||
    Array.isArray(record.publicKey)
  ) {
    throw new Error("Malformed device identity")
  }
  const publicKey = Object.fromEntries(Object.entries(record.publicKey))
  const encryptionPublicKey = record.encryptionPublicKey && typeof record.encryptionPublicKey === "object" && !Array.isArray(record.encryptionPublicKey)
    ? Object.fromEntries(Object.entries(record.encryptionPublicKey)) : null
  if (
    publicKey.algorithm !== "Ed25519" ||
    publicKey.encoding !== "base64url" ||
    typeof publicKey.value !== "string" ||
    !/^[A-Za-z0-9_-]{43}$/u.test(publicKey.value)
  ) {
    throw new Error("Malformed device public key")
  }
  const legacy: LegacyStoredDeviceIdentity = {
    version: 1,
    algorithm: "Ed25519",
    privateKeyPkcs8: record.privateKeyPkcs8,
    publicKey: { algorithm: "Ed25519", encoding: "base64url", value: publicKey.value }
  }
  if (record.encryptionPrivateKeyPkcs8 === undefined && encryptionPublicKey === null) return legacy
  if (
    typeof record.encryptionPrivateKeyPkcs8 !== "string" ||
    encryptionPublicKey?.algorithm !== "X25519" ||
    encryptionPublicKey.encoding !== "base64url" ||
    typeof encryptionPublicKey.value !== "string" ||
    !/^[A-Za-z0-9_-]{43}$/u.test(encryptionPublicKey.value)
  ) {
    throw new Error("Malformed device encryption key")
  }
  return {
    ...legacy,
    encryptionPrivateKeyPkcs8: record.encryptionPrivateKeyPkcs8,
    encryptionPublicKey: {
      algorithm: "X25519",
      encoding: "base64url",
      value: encryptionPublicKey.value
    }
  }
}

const hasEncryptionKey = (
  stored: StoredDeviceIdentity | LegacyStoredDeviceIdentity
): stored is StoredDeviceIdentity => "encryptionPrivateKeyPkcs8" in stored

const addEncryptionIdentity = (
  stored: LegacyStoredDeviceIdentity
): StoredDeviceIdentity => {
  const encryption = generateKeyPairSync("x25519")
  return {
    ...stored,
    encryptionPublicKey: encryptionPublicKeyOf(encryption.publicKey),
    encryptionPrivateKeyPkcs8: Buffer.from(
      encryption.privateKey.export({ format: "der", type: "pkcs8" })
    ).toString("base64")
  }
}

const replaceStored = async (path: string, stored: StoredDeviceIdentity): Promise<void> => {
  const next = `${path}.${process.pid}.next`
  await writeFile(next, `${JSON.stringify(stored)}\n`, { mode: 0o600, flag: "wx" })
  try {
    await rename(next, path)
    await chmod(path, 0o600)
  } catch (error) {
    await rm(next, { force: true })
    throw error
  }
}

const createStored = (): StoredDeviceIdentity => {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519")
  const encryption = generateKeyPairSync("x25519")
  return {
    version: 1,
    algorithm: "Ed25519",
    publicKey: publicKeyOf(publicKey),
    privateKeyPkcs8: Buffer.from(
      privateKey.export({ format: "der", type: "pkcs8" })
    ).toString("base64"),
    encryptionPublicKey: encryptionPublicKeyOf(encryption.publicKey),
    encryptionPrivateKeyPkcs8: Buffer.from(encryption.privateKey.export({ format: "der", type: "pkcs8" })).toString("base64")
  }
}

const loadOrCreatePromise = async (path: string): Promise<DeviceIdentity> => {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  await chmod(dirname(path), 0o700)
  try {
    const raw = await readFile(path, "utf8")
    await chmod(path, 0o600)
    const parsed = parseStored(raw)
    if (hasEncryptionKey(parsed)) return identityFromStored(parsed)
    // Preserve the already-paired signing identity while adding a distinct
    // X25519 key. Replacing Ed25519 here would silently revoke the device.
    const migrated = addEncryptionIdentity(parsed)
    await replaceStored(path, migrated)
    return identityFromStored(migrated)
  } catch (error) {
    if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error
  }
  const stored = createStored()
  const handle = await open(path, "wx", 0o600).catch(async (error: unknown) => {
    if (error instanceof Error && "code" in error && error.code === "EEXIST") return null
    throw error
  })
  if (handle === null) {
    const raw = await readFile(path, "utf8")
    await chmod(path, 0o600)
    const parsed = parseStored(raw)
    if (hasEncryptionKey(parsed)) return identityFromStored(parsed)
    const migrated = addEncryptionIdentity(parsed)
    await replaceStored(path, migrated)
    return identityFromStored(migrated)
  }
  try {
    await handle.writeFile(`${JSON.stringify(stored)}\n`, "utf8")
  } finally {
    await handle.close()
  }
  await chmod(path, 0o600)
  return identityFromStored(stored)
}

export const loadOrCreateDeviceIdentity = (
  path: string
): Effect.Effect<DeviceIdentity, DeviceIdentityError> =>
  Effect.tryPromise({
    try: () => loadOrCreatePromise(path),
    catch: (cause) => new DeviceIdentityError({ message: "Failed to load device identity", cause })
  })

/** Replace the identity atomically, retaining no stale private-key file. */
export const rotateDeviceIdentity = (
  path: string
): Effect.Effect<DeviceIdentity, DeviceIdentityError> =>
  Effect.tryPromise({
    try: async () => {
      await mkdir(dirname(path), { recursive: true, mode: 0o700 })
      const stored = createStored()
      await replaceStored(path, stored)
      return identityFromStored(stored)
    },
    catch: (cause) => new DeviceIdentityError({ message: "Failed to rotate device identity", cause })
  })
