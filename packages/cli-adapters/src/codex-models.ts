import type { ModelOption } from "@jingler/core"
import {
  type CodexAppServerProbeOptions,
  type CodexAppServerSession,
  withCodexAppServer
} from "./codex-app-server.js"

/**
 * Codex's model catalogue, read from the Codex CLI itself.
 *
 * Why not the OpenAI API: `GET api.openai.com/v1/models` needs an
 * `OPENAI_API_KEY`, which Codex users on ChatGPT subscription auth do not have
 * (their credentials live in `~/.codex/auth.json` as refresh tokens). It also
 * returns the *API* catalogue — a different vocabulary from Codex's own models
 * (`gpt-5.6-sol`, `gpt-5.6-terra`, …), most of which it never lists. So that
 * route could not produce a correct list even with a key.
 *
 * Instead we speak the CLI's own app-server protocol over stdio: newline-
 * delimited JSON-RPC, `initialize` then `model/list`. It reuses whatever auth
 * the CLI already has, so it works for subscription and API-key users alike, and
 * the list is exactly what `codex` itself would offer.
 *
 * The protocol is marked experimental upstream, so every failure here is
 * non-fatal — callers fall back to `FALLBACK_MODELS`.
 */

/** One entry of `model/list`'s response (only the fields we consume). */
export interface CodexModel {
  readonly id: string
  readonly displayName?: string
  readonly hidden?: boolean
  readonly isDefault?: boolean
}

const MAX_MODEL_PAGES = 100

/**
 * Fold `model/list`'s payload into chip options — the pure, unit-tested seam
 * (the surrounding process plumbing is verified live, as with `runCodex`).
 */
export const toModelOptions = (models: ReadonlyArray<CodexModel>): ReadonlyArray<ModelOption> => {
  const seen = new Set<string>()
  return models
    // `hidden` models (e.g. codex-auto-review) aren't user-selectable.
    .filter((m) => m?.id && !m.hidden)
    // Surface the CLI's own default first: callers treat index 0 as the default
    // model, so this keeps us in step with `codex` itself.
    .sort((a, b) => Number(b.isDefault ?? false) - Number(a.isDefault ?? false))
    // Keep the first visible occurrence in the server's default-first order.
    .filter((m) => {
      if (seen.has(m.id)) return false
      seen.add(m.id)
      return true
    })
    .map((m) => ({ id: m.id, label: m.displayName ?? m.id }))
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null

const isCodexModel = (value: unknown): value is CodexModel =>
  isRecord(value) &&
  typeof value.id === "string" &&
  value.id.length > 0 &&
  (value.displayName === undefined || typeof value.displayName === "string") &&
  (value.hidden === undefined || typeof value.hidden === "boolean") &&
  (value.isDefault === undefined || typeof value.isDefault === "boolean")

interface CodexModelPage {
  readonly data: ReadonlyArray<CodexModel>
  readonly nextCursor: string | null
}

const decodePage = (response: unknown): CodexModelPage | null => {
  if (!(isRecord(response) && Array.isArray(response.data))) return null
  if (!response.data.every(isCodexModel)) return null
  const nextCursor = response.nextCursor
  if (
    nextCursor !== undefined &&
    nextCursor !== null &&
    (typeof nextCursor !== "string" || nextCursor.length === 0)
  ) {
    return null
  }
  return { data: response.data, nextCursor: nextCursor ?? null }
}

const collectModelPages = async (
  session: CodexAppServerSession
): Promise<ReadonlyArray<CodexModel> | null> => {
  const models: Array<CodexModel> = []
  const seenCursors = new Set<string>()
  let cursor: string | null = null

  for (let pageNumber = 0; pageNumber < MAX_MODEL_PAGES; pageNumber += 1) {
    // biome-ignore lint/performance/noAwaitInLoops: each request needs the cursor returned by the preceding page.
    const response = await session.request(
      "model/list",
      cursor === null ? {} : { cursor }
    )
    const page = decodePage(response)
    if (page === null) return null
    models.push(...page.data)

    if (page.nextCursor === null) return models
    if (seenCursors.has(page.nextCursor)) return null
    seenCursors.add(page.nextCursor)
    cursor = page.nextCursor
  }

  // A server that never terminates pagination is malformed. Do not return a
  // silently truncated catalogue.
  return null
}

/**
 * Ask a Codex binary for its models. Resolves `null` on *any* problem (binary
 * missing, protocol drift, timeout, not logged in) — never rejects, never hangs.
 */
export const fetchCodexModels = async (
  binPath?: string | null,
  options: CodexAppServerProbeOptions = {}
): Promise<ReadonlyArray<ModelOption> | null> =>
  withCodexAppServer(
    binPath,
    async (session) => {
      const models = await collectModelPages(session)
      if (models === null) return null
      const modelOptions = toModelOptions(models)
      return modelOptions.length > 0 ? modelOptions : null
    },
    options
  )
