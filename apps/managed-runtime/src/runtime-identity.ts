export const sha256Hex = async (value: string): Promise<string> => {
  const bytes = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))
  )
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("")
}

/**
 * Cloudflare Sandbox ids are DNS labels, while Jingler session ids are opaque
 * base64url values and may start or end with `-`. Hashing keeps the mapping
 * stable and collision-resistant without leaking transport syntax into the
 * durable session identity.
 */
export const sandboxIdForSession = async (sessionId: string): Promise<string> =>
  `session-${(await sha256Hex(sessionId)).slice(0, 48)}`
