import { execFileSync } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import type { CliKind } from "@jingler/core"

/**
 * Running on the operator's PLAN, not on a metered key they forgot was exported.
 *
 * Jingler's premise is that it drives the harnesses you already pay for. A
 * stray `OPENAI_API_KEY` or `ANTHROPIC_API_KEY` in the shell environment quietly
 * defeats that: the CLI inherits it, prefers it over its own stored
 * subscription auth, and bills per token — with nothing on screen to say so.
 * Found exactly that way, on a machine whose Codex config had
 * `OPENAI_API_KEY: null` and full ChatGPT OAuth tokens, i.e. an operator who had
 * clearly chosen the subscription.
 *
 * So: where a harness HAS subscription auth, its metered key is withheld from
 * the child process. Where it does not, nothing is touched — an operator with
 * only an API key must keep working, and breaking them to enforce a preference
 * they cannot satisfy would be worse than the problem.
 *
 * opencode is deliberately absent from all of this. Its whole model is
 * bring-your-own-key: `opencode-server.ts` passes `process.env` through by
 * design, and stripping keys there would disable the providers it exists to
 * reach.
 */

/** Env vars that divert a harness onto metered billing, per harness. */
export const METERED_ENV_KEYS: Partial<Record<CliKind, ReadonlyArray<string>>> = {
  claude: ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"],
  codex: ["OPENAI_API_KEY"]
}

/** Which account a harness run will actually be charged to. */
export type BillingPath =
  /** The operator's plan — Claude Code / ChatGPT subscription auth. */
  | "subscription"
  /** A metered API key, from the environment. */
  | "api-key"
  /** Neither detected; the harness will decide, and may well fail. */
  | "unknown"
  /**
   * The probe could not read the credential store at all. Distinct from
   * `unknown`: that says "no plan found", this says "we could not look", and
   * telling an operator to sign in when they already are is the worse error.
   */
  | "undetermined"

/**
 * The environment a harness child should run with.
 *
 * Pure, so the decision is testable without a process. Returns a COPY — the SDKs
 * take this as a replacement for `process.env` rather than a patch, so the
 * caller must hand over a complete environment.
 */
export const harnessEnv = (
  cli: CliKind,
  env: Record<string, string | undefined>,
  hasSubscription: boolean
): Record<string, string> => {
  const drop = new Set(hasSubscription ? (METERED_ENV_KEYS[cli] ?? []) : [])
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined || drop.has(k)) continue
    out[k] = v
  }
  return out
}

/**
 * What a run WILL be billed to, for display.
 *
 * Separate from `harnessEnv` because the operator deserves to see this even
 * when we change nothing — the silent case is the one that cost money.
 */
export const billingPath = (
  cli: CliKind,
  env: Record<string, string | undefined>,
  hasSubscription: boolean,
  probeFailed = false
): BillingPath => {
  if (hasSubscription) return "subscription"
  const keys = METERED_ENV_KEYS[cli] ?? []
  // A key present is a definite answer even when the plan probe failed: that
  // key IS what the run will be billed to.
  if (keys.some((k) => (env[k] ?? "").length > 0)) return "api-key"
  return probeFailed ? "undetermined" : "unknown"
}

/**
 * Whether this harness has usable subscription auth on this machine.
 *
 * Deliberately conservative: anything unreadable, unparseable or unrecognised
 * answers `false`, so an uncertain probe never strips a key that might be the
 * only working credential. The failure mode of a false negative is "we changed
 * nothing"; of a false positive, "we broke your auth".
 *
 * Memoised because it is consulted on every run and a Keychain probe spawns a
 * process. The memo is NOT permanent: signing in with `claude login` or `codex
 * login` happens in a terminal and does not restart Jingler, so a cache held
 * for the app's lifetime would keep reporting "not signed in" — and, worse, keep
 * passing a metered key through to a harness that had since gained a plan.
 * `Billing.paths` clears it, so opening the settings pane re-probes.
 */
const cache = new Map<CliKind, boolean>()

/**
 * Where a harness keeps its own credentials.
 *
 * Honours `JINGLER_HARNESS_HOME`, the override the e2e suite already uses to
 * seed a fake `~`. Reading the real home unconditionally made this probe report
 * whatever the DEVELOPER happened to be signed into, so the same test said
 * different things on different machines — the exact non-determinism the
 * fixtures work hard to remove everywhere else.
 */
const harnessHome = (): string => process.env.JINGLER_HARNESS_HOME ?? homedir()

const cloudApiKey = (value: unknown): string | null =>
  typeof value === "string" &&
  value.length >= 20 &&
  value.length <= 512 &&
  [...value].every((character) => {
    const code = character.charCodeAt(0)
    return code >= 33 && code <= 126
  })
    ? value
    : null

const cloudAccessToken = (value: unknown): string | null =>
  typeof value === "string" &&
  value.length >= 20 &&
  value.length <= 4_096 &&
  [...value].every((character) => {
    const code = character.charCodeAt(0)
    return code >= 33 && code <= 126
  })
    ? value
    : null

export type CloudCodexCredential =
  | {
      readonly kind: "api-key"
      readonly token: string
      readonly expiresAt: number
    }
  | {
      readonly kind: "chatgpt"
      readonly token: string
      readonly accountId: string
      readonly expiresAt: number
    }

export type CloudClaudeCredential = {
  readonly kind: "api-key" | "oauth"
  readonly token: string
  readonly expiresAt: number
}

const jwtExpiry = (token: string): number | null => {
  const encoded = token.split(".")[1]
  if (encoded === undefined) return null
  try {
    const payload = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as {
      exp?: unknown
    }
    return typeof payload.exp === "number" && Number.isSafeInteger(payload.exp)
      ? payload.exp
      : null
  } catch {
    return null
  }
}

/**
 * A short-lived Codex credential for the Worker-side managed-runtime proxy.
 * The raw value is never given to the sandbox: the server immediately seals it
 * in auth-state and the container receives a one-command proxy token instead.
 */
export const cloudCodexCredential = (
  environment: Record<string, string | undefined> = process.env,
  nowSeconds = Math.floor(Date.now() / 1_000),
  home = harnessHome()
): CloudCodexCredential | null => {
  try {
    const raw = JSON.parse(
      readFileSync(join(home, ".codex", "auth.json"), "utf8")
    ) as {
      OPENAI_API_KEY?: unknown
      tokens?: {
        access_token?: unknown
        account_id?: unknown
      } | null
    }
    const accessToken = cloudAccessToken(raw.tokens?.access_token)
    const accountId = raw.tokens?.account_id
    const expiresAt = accessToken === null ? null : jwtExpiry(accessToken)
    if (
      accessToken !== null &&
      typeof accountId === "string" &&
      /^[0-9a-f]{8}-[0-9a-f-]{27,36}$/iu.test(accountId) &&
      expiresAt !== null &&
      expiresAt > nowSeconds + 60
    ) {
      return { kind: "chatgpt", token: accessToken, accountId, expiresAt }
    }
    const storedApiKey = cloudApiKey(raw.OPENAI_API_KEY)
    if (storedApiKey !== null) {
      return {
        kind: "api-key",
        token: storedApiKey,
        expiresAt: nowSeconds + 24 * 60 * 60
      }
    }
  } catch {
    // Fall through to an explicit metered key only when subscription auth is absent.
  }
  const fromEnvironment = cloudApiKey(environment.OPENAI_API_KEY)
  return fromEnvironment === null
    ? null
    : {
        kind: "api-key",
        token: fromEnvironment,
        expiresAt: nowSeconds + 24 * 60 * 60
      }
}

const claudeCredentialDocument = (home: string): unknown => {
  const file = join(home, ".claude", ".credentials.json")
  if (existsSync(file)) return JSON.parse(readFileSync(file, "utf8"))
  if (process.env.JINGLER_HARNESS_HOME !== undefined || process.platform !== "darwin") {
    return null
  }
  return JSON.parse(
    execFileSync(
      "security",
      ["find-generic-password", "-s", "Claude Code-credentials", "-w"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }
    )
  )
}

/** Current Claude credential for the same encrypted Worker-side proxy boundary. */
export const cloudClaudeCredential = (
  environment: Record<string, string | undefined> = process.env,
  nowSeconds = Math.floor(Date.now() / 1_000),
  home = harnessHome()
): CloudClaudeCredential | null => {
  try {
    const document = claudeCredentialDocument(home)
    if (typeof document === "object" && document !== null) {
      const credential = Object.fromEntries(Object.entries(document)).claudeAiOauth
      if (typeof credential === "object" && credential !== null) {
        const fields = Object.fromEntries(Object.entries(credential))
        const token = cloudAccessToken(fields.accessToken)
        const rawExpiry = fields.expiresAt
        const expiresAt = typeof rawExpiry === "number" && Number.isSafeInteger(rawExpiry)
          ? rawExpiry > 10_000_000_000
            ? Math.floor(rawExpiry / 1_000)
            : rawExpiry
          : null
        if (token !== null && expiresAt !== null && expiresAt > nowSeconds + 60) {
          return { kind: "oauth", token, expiresAt }
        }
      }
    }
  } catch {
    // Fall through to explicit credentials only when subscription auth is absent.
  }
  const explicitOauth = cloudAccessToken(environment.ANTHROPIC_AUTH_TOKEN)
  if (explicitOauth !== null) {
    return { kind: "oauth", token: explicitOauth, expiresAt: nowSeconds + 60 * 60 }
  }
  const apiKey = cloudApiKey(environment.ANTHROPIC_API_KEY)
  return apiKey === null
    ? null
    : { kind: "api-key", token: apiKey, expiresAt: nowSeconds + 24 * 60 * 60 }
}

/**
 * Whether the probe itself could not run, as opposed to finding no plan.
 *
 * Recorded because the two are different claims and only one is actionable. A
 * harness with genuinely no subscription should be told to sign in; a harness
 * whose credential store we failed to READ (permissions, an unreadable
 * Keychain, a platform with neither) is a Jingler problem the operator can do
 * nothing about, and reporting it as "not signed in" sends them to fix
 * something that is not broken.
 *
 * The conservative default is unchanged either way: an unreadable probe still
 * answers "no subscription", so no key is ever stripped on a guess.
 */
const indeterminate = new Set<CliKind>()

const detect = (cli: CliKind): boolean => {
  try {
    if (cli === "codex") {
      // `auth.json` carries either OAuth `tokens` (ChatGPT plan) or an API key.
      // Only the former counts: a file holding a key IS the metered path.
      const file = join(harnessHome(), ".codex", "auth.json")
      if (!existsSync(file)) return false
      const raw = JSON.parse(readFileSync(file, "utf8")) as {
        tokens?: { access_token?: unknown } | null
      }
      return typeof raw.tokens?.access_token === "string" && raw.tokens.access_token.length > 0
    }
    if (cli === "claude") {
      // Linux and some installs keep credentials on disk…
      if (existsSync(join(harnessHome(), ".claude", ".credentials.json"))) return true
      // …macOS puts them in the Keychain. Querying by service name reports
      // presence without ever reading the secret.
      // A seeded harness home means a TEST: the Keychain belongs to the real
      // machine and would leak the developer's own sign-in into the result.
      if (process.env.JINGLER_HARNESS_HOME !== undefined) return false
      // Not macOS and no credentials file: Claude Code may still be signed in
      // somewhere we cannot see, so this is "could not tell" rather than "no".
      if (process.platform !== "darwin") {
        indeterminate.add("claude")
        return false
      }
      execFileSync("security", ["find-generic-password", "-s", "Claude Code-credentials"], {
        stdio: "ignore"
      })
      return true
    }
    return false
  } catch {
    indeterminate.add(cli)
    return false
  }
}

export const hasSubscriptionAuth = (cli: CliKind): boolean => {
  const hit = cache.get(cli)
  if (hit !== undefined) return hit
  indeterminate.delete(cli)
  const found = detect(cli)
  cache.set(cli, found)
  return found
}

/**
 * Whether the last probe for this harness failed rather than answered.
 *
 * Only meaningful after `hasSubscriptionAuth` has run for the same harness.
 */
export const subscriptionProbeFailed = (cli: CliKind): boolean => indeterminate.has(cli)

/** Forget the probe — for tests, and for a re-check after a sign-in. */
export const resetSubscriptionCache = (): void => {
  cache.clear()
  indeterminate.clear()
}
