import type { RelayGrantClaims } from "./auth.js"
import type { NormalizedGitHubEvent } from "./github-webhook.js"

const encoder = new TextEncoder()

const base64Url = (bytes: Uint8Array): string => {
  let binary = ""
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "")
}

const jsonPart = (value: unknown): string => base64Url(encoder.encode(JSON.stringify(value)))

export const hmacHex = async (body: string, secret: string): Promise<string> => {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  )
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(body))
  return [...new Uint8Array(signature)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")
}

export const issueTestRelayGrant = async (
  overrides: Partial<RelayGrantClaims> = {},
  secret = "test-relay-signing-secret"
): Promise<string> => {
  const claims: RelayGrantClaims = {
    version: 1,
    issuer: "jingler",
    audience: "jingler-github-relay",
    subject: "user-1",
    installationId: "99",
    relaySessionId: "relay-session-0001",
    issuedAt: 100,
    expiresAt: 400,
    grantId: "grant-1",
    ...overrides
  }
  const header = jsonPart({ alg: "HS256", typ: "JinglerGitHubGrant", version: 1 })
  const payload = jsonPart(claims)
  const signed = `${header}.${payload}`
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  )
  return `${signed}.${base64Url(new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(signed))))}`
}

export const githubPayload = (overrides: Record<string, unknown> = {}) => ({
  action: "created",
  installation: { id: 99 },
  repository: {
    id: 10,
    name: "jingler",
    full_name: "acme/jingler",
    owner: { login: "acme" }
  },
  sender: { id: 7, login: "reviewer", type: "User" },
  issue: {
    id: 200,
    number: 42,
    title: "Improve relay",
    html_url: "https://github.com/acme/jingler/pull/42",
    pull_request: { url: "https://api.github.com/repos/acme/jingler/pulls/42" }
  },
  comment: {
    id: 300,
    body: "Please cover reconnect replay.",
    created_at: "2026-08-05T10:00:00Z"
  },
  ...overrides
})

export const normalizedEvent = (
  overrides: Partial<NormalizedGitHubEvent> = {}
): NormalizedGitHubEvent => ({
  version: 1,
  deliveryId: "delivery-1",
  semanticKey: "semantic-1",
  event: "issue_comment",
  action: "created",
  installationId: "99",
  repository: { id: "10", owner: "acme", name: "jingler", fullName: "acme/jingler" },
  pullRequest: {
    id: "200",
    number: 42,
    title: "Improve relay",
    url: "https://github.com/acme/jingler/pull/42",
    headSha: "",
    baseSha: ""
  },
  actor: { id: "7", login: "reviewer", type: "User" },
  feedback: {
    kind: "issue-comment",
    id: "300",
    body: "Please cover reconnect replay.",
    state: null,
    path: null,
    line: null,
    side: null
  },
  actionable: true,
  occurredAt: "2026-08-05T10:00:00Z",
  ...overrides
})
