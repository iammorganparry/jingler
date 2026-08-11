const bytes = new TextEncoder()

const base64 = (value: Uint8Array): string => {
  let binary = ""
  for (const byte of value) binary += String.fromCharCode(byte)
  return btoa(binary)
}

const fromBase64 = (value: string): Uint8Array => {
  const binary = atob(value)
  return Uint8Array.from(binary, (character) => character.charCodeAt(0))
}

const keyOf = async (secret: string): Promise<CryptoKey> => {
  if (bytes.encode(secret).byteLength < 32) {
    throw new Error("AUTH_STATE_ENCRYPTION_KEY must contain at least 32 bytes")
  }
  const digest = await crypto.subtle.digest("SHA-256", bytes.encode(secret))
  return crypto.subtle.importKey("raw", digest, "AES-GCM", false, ["encrypt", "decrypt"])
}

export const sealCredential = async (value: string, secret: string): Promise<string> => {
  const nonce = crypto.getRandomValues(new Uint8Array(12))
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: nonce },
    await keyOf(secret),
    bytes.encode(value)
  )
  return `v1.${base64(nonce)}.${base64(new Uint8Array(ciphertext))}`
}

export const openCredential = async (envelope: string, secret: string): Promise<string> => {
  const [version, nonce, ciphertext] = envelope.split(".")
  if (version !== "v1" || nonce === undefined || ciphertext === undefined) {
    throw new Error("Invalid credential envelope")
  }
  const initializationVector = new Uint8Array(fromBase64(nonce))
  const encrypted = new Uint8Array(fromBase64(ciphertext))
  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: initializationVector },
    await keyOf(secret),
    encrypted
  )
  return new TextDecoder().decode(plaintext)
}
