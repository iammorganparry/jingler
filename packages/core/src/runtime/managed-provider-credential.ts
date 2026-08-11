import { Schema } from "effect";
import {
  AuthKind,
  ProviderConnectionId,
  ProviderId,
  ProviderModelId,
} from "./provider-connection.js";

export const ManagedProviderProxy = Schema.Literal("codex", "claude");
export type ManagedProviderProxy = Schema.Schema.Type<
  typeof ManagedProviderProxy
>;

/** Secret-free identity carried through auth state and the managed runtime. */
export const ManagedProviderCapability = Schema.Struct({
  version: Schema.Literal(1),
  proxy: ManagedProviderProxy,
  connectionId: ProviderConnectionId,
  providerId: ProviderId,
  authKind: AuthKind,
  billingRoute: Schema.Literal("subscription", "api"),
  handle: Schema.String.pipe(Schema.minLength(1), Schema.maxLength(256)),
  expiresAt: Schema.Int.pipe(Schema.positive()),
});
export type ManagedProviderCapability = Schema.Schema.Type<
  typeof ManagedProviderCapability
>;

/** Exact inference identity sent with each managed workspace/grant request. */
export const ManagedRuntimeProviderSelection = Schema.Struct({
  connectionId: ProviderConnectionId,
  providerId: ProviderId,
  modelId: ProviderModelId,
});
export type ManagedRuntimeProviderSelection = Schema.Schema.Type<
  typeof ManagedRuntimeProviderSelection
>;

/**
 * Short-lived, connection-pinned credential handoff from desktop main to the
 * managed control plane. This schema must never cross into renderer state.
 */
export const ManagedProviderCredential = Schema.Struct({
  version: Schema.Literal(1),
  connectionId: ProviderConnectionId,
  providerId: ProviderId,
  authKind: AuthKind,
  access: Schema.String.pipe(Schema.minLength(20), Schema.maxLength(4_096)),
  expiresAt: Schema.NullOr(Schema.Number),
  accountId: Schema.NullOr(
    Schema.String.pipe(Schema.minLength(1), Schema.maxLength(160)),
  ),
  billingRoute: Schema.Literal("subscription", "api", "device-environment"),
});
export type ManagedProviderCredential = Schema.Schema.Type<
  typeof ManagedProviderCredential
>;
