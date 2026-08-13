import { ProviderId, ProviderModelId } from "@jingler/core";
import { Schema } from "effect";

export const RealProviderRoute = Schema.Literal("claude", "codex");
export type RealProviderRoute = Schema.Schema.Type<typeof RealProviderRoute>;

export const RealProviderTarget = Schema.Struct({
  route: RealProviderRoute,
  providerId: ProviderId,
  modelId: ProviderModelId,
  connectionLabel: Schema.String.pipe(Schema.minLength(1)),
  label: Schema.String.pipe(Schema.minLength(1)),
});
export type RealProviderTarget = Schema.Schema.Type<typeof RealProviderTarget>;

const target = (input: RealProviderTarget): RealProviderTarget =>
  Schema.decodeUnknownSync(RealProviderTarget)(input);

// Newest Claude and Codex families in the pinned pi 0.84.1 catalog. Exact IDs
// make catalog upgrades deliberate: the real local and Cloud canaries fail
// together instead of silently testing whichever model happens to sort first.
export const REAL_PROVIDER_TARGETS: ReadonlyArray<RealProviderTarget> = [
  target({
    route: "codex",
    providerId: "openai-codex",
    modelId: "openai-codex/gpt-5.6-sol",
    connectionLabel: "ChatGPT Codex subscription",
    label: "GPT-5.6 Sol",
  }),
  target({
    route: "claude",
    providerId: "anthropic",
    modelId: "anthropic/claude-fable-5",
    connectionLabel: "Claude Pro / Max setup-token",
    label: "Claude Fable 5",
  }),
];

export const realProviderTarget = (
  route: RealProviderRoute,
): RealProviderTarget => {
  const match = REAL_PROVIDER_TARGETS.find(
    (candidate) => candidate.route === route,
  );
  if (match === undefined) {
    throw new Error(`No real provider target is configured for ${route}`);
  }
  return match;
};
