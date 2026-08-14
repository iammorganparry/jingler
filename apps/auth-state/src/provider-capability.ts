import {
  AuthKind,
  ManagedProviderProxy,
  ProviderConnectionId,
  ProviderId,
} from "@jingler/core";
import { Either, Schema } from "effect";
import type { CapabilityProvider, CapabilityUpstream } from "./state.js";

const Identifier = Schema.String.pipe(
  Schema.minLength(1),
  Schema.maxLength(256),
);
const AuthorizationHeader = Schema.String.pipe(
  Schema.minLength(8),
  Schema.maxLength(16_384),
);

export const CapabilityProviderSchema = Schema.Literal(
  "github",
  "codex",
  "claude",
);
const CapabilityUpstreamSchema = Schema.Literal(
  "github-api",
  "openai-api",
  "chatgpt-codex",
  "anthropic-api",
);
const CapabilityInput = Schema.Struct({
  subject: Identifier,
  provider: CapabilityProviderSchema,
  authorizationHeader: AuthorizationHeader,
  expiresAt: Schema.Int,
  upstream: Schema.optional(CapabilityUpstreamSchema),
  accountId: Schema.optional(Identifier),
  proxy: Schema.optional(ManagedProviderProxy),
  connectionId: Schema.optional(ProviderConnectionId),
  providerId: Schema.optional(ProviderId),
  authKind: Schema.optional(AuthKind),
  billingRoute: Schema.optional(Schema.Literal("subscription", "api")),
});
const CapabilityRouteMetadata = Schema.Struct({
  provider: CapabilityProviderSchema,
  upstream: Schema.optional(CapabilityUpstreamSchema),
  proxy: Schema.optional(ManagedProviderProxy),
  providerId: Schema.optional(ProviderId),
  authKind: Schema.optional(AuthKind),
  billingRoute: Schema.optional(Schema.Literal("subscription", "api")),
});

const ProviderConnectionCapabilityInput = Schema.Struct({
  proxy: ManagedProviderProxy,
  connectionId: ProviderConnectionId,
  providerId: ProviderId,
  authKind: AuthKind,
  billingRoute: Schema.Literal("subscription", "api"),
});
type ProviderConnectionCapabilityInput = Schema.Schema.Type<
  typeof ProviderConnectionCapabilityInput
>;

const decodeStrict = <A, I>(
  schema: Schema.Schema<A, I, never>,
  value: unknown,
): A | null => {
  const decoded = Schema.decodeUnknownEither(schema)(value, {
    onExcessProperty: "error",
  });
  return Either.isRight(decoded) ? decoded.right : null;
};

const decodeProjection = <A, I>(
  schema: Schema.Schema<A, I, never>,
  value: unknown,
): A | null => {
  const decoded = Schema.decodeUnknownEither(schema)(value, {
    onExcessProperty: "ignore",
  });
  return Either.isRight(decoded) ? decoded.right : null;
};

/** Secret-free route identity for rejection diagnostics. */
export const capabilityRouteMetadata = (
  body: unknown,
): Schema.Schema.Type<typeof CapabilityRouteMetadata> | null =>
  decodeProjection(CapabilityRouteMetadata, body);

const upstreamOf = (
  provider: CapabilityProvider,
  value: CapabilityUpstream | undefined,
): CapabilityUpstream | null => {
  if (provider === "github")
    return value === undefined || value === "github-api" ? "github-api" : null;
  if (provider === "codex") {
    return value === undefined || value === "openai-api"
      ? "openai-api"
      : value === "chatgpt-codex"
        ? value
        : null;
  }
  return value === undefined || value === "anthropic-api"
    ? "anthropic-api"
    : null;
};

const matchesProviderRoute = (
  provider: Exclude<CapabilityProvider, "github">,
  connection: ProviderConnectionCapabilityInput,
  upstream: CapabilityUpstream,
): boolean => {
  if (provider === "codex") {
    return (
      connection.proxy === "codex" &&
      ((connection.providerId === "openai-codex" &&
        connection.authKind === "openai-codex-oauth" &&
        connection.billingRoute === "subscription" &&
        upstream === "chatgpt-codex") ||
        (connection.providerId === "openai" &&
          connection.authKind === "api-key" &&
          connection.billingRoute === "api" &&
          upstream === "openai-api"))
    );
  }
  return (
    connection.proxy === "claude" &&
    connection.providerId === "anthropic" &&
    upstream === "anthropic-api" &&
    ((connection.authKind === "claude-setup-token" &&
      connection.billingRoute === "subscription") ||
      (connection.authKind === "api-key" && connection.billingRoute === "api"))
  );
};

export interface ValidatedCapability {
  readonly provider: CapabilityProvider;
  readonly upstream: CapabilityUpstream;
  readonly authorizationHeader: string;
  readonly accountId: string | null;
  readonly expiresAt: number;
  readonly providerConnection?: ProviderConnectionCapabilityInput;
}

export type CapabilityValidation =
  | { readonly ok: true; readonly value: ValidatedCapability }
  | { readonly ok: false; readonly error: string };

const hasSupportedAuthorization = (value: string): boolean => {
  if (value.includes("\r") || value.includes("\n")) return false;
  const prefix = value.startsWith("Bearer ")
    ? "Bearer "
    : value.startsWith("X-Api-Key ")
      ? "X-Api-Key "
      : null;
  return prefix !== null && value.slice(prefix.length).trim().length > 0;
};

const hasValidAccountScope = (
  upstream: CapabilityUpstream,
  accountId: string | null,
): boolean =>
  upstream === "chatgpt-codex" ? accountId !== null : accountId === null;

export const validateCapability = (
  body: unknown,
  now: number,
): CapabilityValidation => {
  const input = decodeStrict(CapabilityInput, body);
  if (
    input === null ||
    !hasSupportedAuthorization(input.authorizationHeader) ||
    input.expiresAt <= now
  ) {
    return { ok: false, error: "Invalid capability" };
  }
  const upstream = upstreamOf(input.provider, input.upstream);
  if (upstream === null) return { ok: false, error: "Invalid capability" };
  const providerConnection =
    input.provider === "github"
      ? undefined
      : decodeStrict(ProviderConnectionCapabilityInput, {
          proxy: input.proxy,
          connectionId: input.connectionId,
          providerId: input.providerId,
          authKind: input.authKind,
          billingRoute: input.billingRoute,
        });
  if (
    input.provider !== "github" &&
    (providerConnection === null ||
      providerConnection === undefined ||
      !matchesProviderRoute(input.provider, providerConnection, upstream))
  ) {
    return { ok: false, error: "Invalid provider connection capability" };
  }
  const accountId = input.accountId ?? null;
  if (!hasValidAccountScope(upstream, accountId)) {
    return { ok: false, error: "Invalid capability scope" };
  }
  return {
    ok: true,
    value: {
      provider: input.provider,
      upstream,
      authorizationHeader: input.authorizationHeader,
      accountId,
      expiresAt: input.expiresAt,
      ...(providerConnection === null || providerConnection === undefined
        ? {}
        : { providerConnection }),
    },
  };
};
