import { Schema } from "effect"
import { type CliKind, ReasoningEffort } from "./domain.js"

/** A model a harness can run, shown in the composer's model chip. */
export const ModelOption = Schema.Struct({
  /** The id passed to the harness (`--model` / SDK `model`). */
  id: Schema.String,
  /** Short label shown in the chip/menu. */
  label: Schema.String,
  description: Schema.optional(Schema.String),
  reasoning: Schema.optional(
    Schema.Array(
      Schema.Struct({ id: ReasoningEffort, label: Schema.String })
    )
  ),
  defaultReasoningId: Schema.optional(ReasoningEffort)
})
export type ModelOption = Schema.Schema.Type<typeof ModelOption>

/**
 * Fallback model choices per harness — used only when live discovery from the
 * provider fails (offline / no credentials). The real list is fetched at runtime
 * by `ModelsService`; the first entry here is the default model. Kept small and
 * conservative on purpose.
 */
export const FALLBACK_MODELS: Record<CliKind, ReadonlyArray<ModelOption>> = {
  claude: [
    // Claude Code's own model picker is the source for these ids. Keep the
    // moving `opus` alias first: `defaultModel` uses index 0, and existing
    // sessions expect the default to follow Claude Code's current Opus release.
    { id: "opus", label: "Opus 5" },
    // Pinned alongside the alias on purpose. Claude Code's `/model` shortlist
    // lags a release — Opus 5 shipped reachable via `--model claude-opus-5`
    // before it appeared in the picker — so a session that wants *this* release
    // rather than "whatever Opus resolves to next" needs an explicit id. Opus 5
    // is 1M by default and maximum, so unlike 4.8/4.7/4.6 there is no `[1m]`
    // variant to offer.
    { id: "claude-opus-5", label: "Opus 5 (pinned)" },
    { id: "claude-opus-4-8", label: "Opus 4.8" },
    { id: "claude-opus-4-8[1m]", label: "Opus 4.8 1M" },
    { id: "claude-opus-4-7[1m]", label: "Opus 4.7 1M" },
    { id: "claude-opus-4-6[1m]", label: "Opus 4.6 1M" },
    { id: "sonnet[1m]", label: "Sonnet 5 1M" },
    { id: "claude-sonnet-4-6[1m]", label: "Sonnet 4.6 1M" },
    { id: "claude-sonnet-4-6", label: "Sonnet 4.6" },
    { id: "haiku", label: "Haiku 4.5" },
    { id: "claude-fable-5", label: "Fable 5" }
  ],
  // Codex's real catalogue comes from the CLI itself (`codex app-server` →
  // `model/list`), which is authoritative and needs no API key. These are only
  // the offline shape. Do NOT reach for the OpenAI *API* catalogue here: Codex
  // models are a different vocabulary and mostly aren't served from /v1/models.
  codex: [
    { id: "gpt-5.6-sol", label: "gpt-5.6-sol" },
    { id: "gpt-5.6-terra", label: "gpt-5.6-terra" },
    { id: "gpt-5.6-luna", label: "gpt-5.6-luna" },
    { id: "gpt-5.5", label: "gpt-5.5" }
  ],
  cursor: [
    { id: "auto", label: "auto" },
    { id: "sonnet-4.5", label: "sonnet-4.5" },
    { id: "gpt-5", label: "gpt-5" }
  ],
  // opencode ids are provider-qualified (`provider/model`), and the provider can
  // itself contain slashes — `openrouter/anthropic/claude-opus-4.5` is one id, so
  // only the FIRST slash separates provider from model (see `splitModelId`).
  //
  // These are opencode Zen's *free* tier on purpose. opencode resolves providers
  // from the user's own credentials, so with none configured the only thing that
  // runs is Zen free (opencode drops every model with a non-zero input cost and
  // falls back to a "public" key). That makes this list the honest offline answer
  // AND a working zero-config first run. The real catalogue — including the
  // user's OpenRouter/Anthropic models — comes live from `ModelsService`.
  //
  // NOTE: `defaultModel` takes index 0, so this also seeds a new session's model.
  // opencode users who configured their own default deserve *that* instead —
  // `/config/providers` returns a `default` map per provider, which live
  // discovery should prefer over this list.
  opencode: [
    { id: "opencode/big-pickle", label: "big-pickle" },
    { id: "opencode/north-mini-code-free", label: "north-mini-code-free" },
    { id: "opencode/hy3-free", label: "hy3-free" }
  ]
}

/** The default model id for a harness (the first fallback option). */
export const defaultModel = (cli: CliKind): string => FALLBACK_MODELS[cli][0]!.id

/**
 * Split a provider-qualified model id into the `{providerID, modelID}` pair
 * opencode's API wants. Only the FIRST slash separates them: the provider id
 * never contains a slash but the model id routinely does —
 * `openrouter/anthropic/claude-opus-4.5` is provider `openrouter`, model
 * `anthropic/claude-opus-4.5`. A naive `split("/")` silently mangles every
 * OpenRouter model.
 *
 * Lives here rather than in the opencode adapter so `vendor.ts` can resolve a
 * model id to the lab behind it without `core` depending on `cli-adapters`.
 */
export const splitModelId = (id: string): { providerID: string; modelID: string } => {
  const i = id.indexOf("/")
  return i === -1
    ? { providerID: id, modelID: "" }
    : { providerID: id.slice(0, i), modelID: id.slice(i + 1) }
}
