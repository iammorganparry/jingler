import {
  ManagedProviderCapability,
  ManagedRuntimeProviderSelection,
  type ManagedProviderCapability as ManagedProviderCapabilityValue,
  type ManagedRuntimeProviderSelection as ManagedRuntimeProviderSelectionValue,
} from "@jingler/core";
import { Schema } from "effect";

export const ManagedRuntimeConfiguration = Schema.Struct({
  subject: Schema.String.pipe(Schema.minLength(1), Schema.maxLength(256)),
  environmentId: Schema.String.pipe(Schema.minLength(1), Schema.maxLength(128)),
  sessionId: Schema.String.pipe(Schema.minLength(1), Schema.maxLength(128)),
  environmentGeneration: Schema.Int.pipe(Schema.positive()),
  authStateVersion: Schema.Int.pipe(Schema.positive()),
  providerConnection: ManagedProviderCapability,
  githubCapabilityHandle: Schema.NullOr(
    Schema.String.pipe(Schema.minLength(1), Schema.maxLength(256)),
  ),
  repositorySlug: Schema.optional(
    Schema.String.pipe(Schema.minLength(1), Schema.maxLength(256)),
  ),
  reservationId: Schema.NullOr(
    Schema.String.pipe(Schema.minLength(8), Schema.maxLength(128)),
  ),
  ...ManagedRuntimeProviderSelection.fields,
});

export type ManagedRuntimeConfiguration = Schema.Schema.Type<
  typeof ManagedRuntimeConfiguration
>;

export interface RuntimeRegistrationInput
  extends ManagedRuntimeProviderSelectionValue {
  readonly subject: string;
  readonly environmentId: string;
  readonly environmentGeneration: number;
  readonly sessionId: string;
  readonly reservationId: string | null;
  readonly repositorySlug?: string;
}

interface RuntimeRegistrationCapabilities {
  readonly authStateVersion: number;
  readonly providerConnection: ManagedProviderCapabilityValue;
  readonly githubCapabilityHandle: string | null;
}

export const runtimeConfigurationForRegistration = (
  input: RuntimeRegistrationInput,
  capabilities: RuntimeRegistrationCapabilities,
): ManagedRuntimeConfiguration => ({
  subject: input.subject,
  environmentId: input.environmentId,
  environmentGeneration: input.environmentGeneration,
  sessionId: input.sessionId,
  reservationId: input.reservationId,
  connectionId: input.connectionId,
  providerId: input.providerId,
  modelId: input.modelId,
  authStateVersion: capabilities.authStateVersion,
  providerConnection: capabilities.providerConnection,
  githubCapabilityHandle: capabilities.githubCapabilityHandle,
  ...(input.repositorySlug === undefined
    ? {}
    : { repositorySlug: input.repositorySlug }),
});
