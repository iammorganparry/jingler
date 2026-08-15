import { execFile } from "node:child_process"
import { readFile } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"
import { Option, Schema } from "effect"

/**
 * The Claude Code CLI's own OAuth credential, read from where the CLI stores
 * it — the macOS keychain, or `~/.claude/.credentials.json` elsewhere.
 *
 * Why this exists: a pasted `claude setup-token` authenticates inference but
 * does not carry the usage scope, so Anthropic's usage endpoint rejects it
 * (HTTP 403). The CLI's browser-login token DOES carry it, and any machine
 * running Claude sessions through Jingler has that CLI signed in. This reads
 * the token for the usage query only — it is never stored, never used for
 * inference, and never leaves the desktop target.
 */

const ClaudeCliOauth = Schema.Struct({
  accessToken: Schema.String,
  /** Epoch milliseconds; the CLI refreshes the token itself before expiry. */
  expiresAt: Schema.optionalWith(Schema.NullOr(Schema.Number), {
    default: () => null
  })
})

const ClaudeCliCredentials = Schema.Struct({
  claudeAiOauth: Schema.optionalWith(Schema.NullOr(ClaudeCliOauth), {
    default: () => null
  })
})

const decodeClaudeCliCredentials = Schema.decodeUnknownOption(ClaudeCliCredentials)

/** Injection seam so tests never touch the real keychain or home directory. */
export interface ClaudeCliCredentialSources {
  /** Raw credential JSON from the OS keychain, or null when absent/unsupported. */
  readonly readKeychain: () => Promise<string | null>
  /** Raw credential JSON from `~/.claude/.credentials.json`, or null when absent. */
  readonly readCredentialsFile: () => Promise<string | null>
  readonly now: () => number
}

const KEYCHAIN_SERVICE = "Claude Code-credentials"

const readMacKeychain = (): Promise<string | null> =>
  new Promise((resolve) => {
    execFile(
      "security",
      ["find-generic-password", "-s", KEYCHAIN_SERVICE, "-w"],
      { timeout: 3_000 },
      (error, stdout) => resolve(error ? null : stdout.trim() || null)
    )
  })

export const defaultClaudeCliCredentialSources: ClaudeCliCredentialSources = {
  readKeychain: () =>
    process.platform === "darwin" ? readMacKeychain() : Promise.resolve(null),
  readCredentialsFile: () =>
    readFile(join(homedir(), ".claude", ".credentials.json"), "utf8").catch(
      () => null
    ),
  now: () => Date.now()
}

/** Reject a token that is about to expire — a 401 is worse than no fallback. */
const EXPIRY_SKEW_MS = 60_000

const accessTokenFromRaw = (raw: string, now: number): string | null => {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  const oauth = Option.getOrNull(decodeClaudeCliCredentials(parsed))?.claudeAiOauth
  if (!oauth) return null
  if (oauth.expiresAt !== null && oauth.expiresAt <= now + EXPIRY_SKEW_MS) {
    return null
  }
  return oauth.accessToken
}

/**
 * The CLI's live OAuth access token, or null when the CLI isn't signed in on
 * this machine (or its token has expired — the CLI refreshes on its own next
 * run; this never refreshes on its behalf).
 */
export const readLocalClaudeCliAccessToken = async (
  sources: ClaudeCliCredentialSources = defaultClaudeCliCredentialSources
): Promise<string | null> => {
  for (const read of [sources.readKeychain, sources.readCredentialsFile]) {
    const raw = await read().catch(() => null)
    if (raw === null) continue
    const token = accessTokenFromRaw(raw, sources.now())
    if (token !== null) return token
  }
  return null
}
