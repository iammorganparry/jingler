import { generateKeyPairSync, verify } from "node:crypto"
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect } from "effect"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { loadOrCreateDeviceIdentity } from "./device-identity.js"

describe("device identity", () => {
  let root = ""
  let identityPath = ""

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "jingler-device-identity-"))
    identityPath = join(root, "device", "identity.json")
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it("creates a restrictive device identity on first start", async () => {
    const identity = await Effect.runPromise(loadOrCreateDeviceIdentity(identityPath))
    const mode = (await stat(identityPath)).mode & 0o777
    expect(mode).toBe(0o600)
    expect(identity.publicKey).toMatchObject({ algorithm: "Ed25519", encoding: "base64url" })
    expect(identity.encryptionPublicKey).toMatchObject({ algorithm: "X25519", encoding: "base64url" })
    expect(await readFile(identityPath, "utf8")).not.toContain('"grant"')
  })

  it("reuses the same identity after restart", async () => {
    const first = await Effect.runPromise(loadOrCreateDeviceIdentity(identityPath))
    const second = await Effect.runPromise(loadOrCreateDeviceIdentity(identityPath))
    expect(second.publicKey).toStrictEqual(first.publicKey)
    expect(second.encryptionPublicKey).toStrictEqual(first.encryptionPublicKey)
    expect(second.sign(new TextEncoder().encode("same challenge"))).toBe(
      first.sign(new TextEncoder().encode("same challenge"))
    )
  })

  it("adds encryption material without replacing a legacy signing identity", async () => {
    const signing = generateKeyPairSync("ed25519")
    const jwk = signing.publicKey.export({ format: "jwk" })
    await mkdir(join(root, "device"), { recursive: true })
    await writeFile(identityPath, JSON.stringify({
      version: 1,
      algorithm: "Ed25519",
      publicKey: { algorithm: "Ed25519", encoding: "base64url", value: jwk.x },
      privateKeyPkcs8: Buffer.from(
        signing.privateKey.export({ format: "der", type: "pkcs8" })
      ).toString("base64")
    }), { mode: 0o600 })

    const identity = await Effect.runPromise(loadOrCreateDeviceIdentity(identityPath))
    expect(identity.publicKey.value).toBe(jwk.x)
    expect(identity.encryptionPublicKey.algorithm).toBe("X25519")
    expect(JSON.parse(await readFile(identityPath, "utf8"))).toHaveProperty(
      "encryptionPrivateKeyPkcs8"
    )
  })

  it("signs a server nonce without exposing private key material", async () => {
    const identity = await Effect.runPromise(loadOrCreateDeviceIdentity(identityPath))
    const payload = new TextEncoder().encode("server-issued-nonce")
    const publicKey = generateKeyPairSync("ed25519").publicKey
    const devicePublicKey = publicKey.export({ format: "jwk" })
    devicePublicKey.x = identity.publicKey.value
    const signature = Buffer.from(identity.sign(payload), "base64url")
    expect(verify(null, payload, { key: devicePublicKey, format: "jwk" }, signature)).toBe(true)
    expect(Object.keys(identity).sort()).toStrictEqual(["deriveSessionSecret", "encryptionPublicKey", "publicKey", "sign", "signChallenge"])
  })
})
