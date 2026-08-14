import type {
  AuthKind,
  ManagedProviderCapability,
  ProviderConnectionId,
  ProviderId,
} from "@jingler/core";

export type CapabilityProvider =
  | "github"
  | "codex"
  | "claude"
  | "exa"
  | "firecrawl";
export type CapabilityUpstream =
  | "github-api"
  | "openai-api"
  | "chatgpt-codex"
  | "anthropic-api"
  | "exa-api"
  | "firecrawl-api";

export interface AuthSession {
  readonly id: string;
  readonly expiresAt: number;
}

export interface StoredCredential {
  readonly provider: CapabilityProvider;
  readonly handle: string;
  /** Stable one-way identity used to make repeated capability sync idempotent. */
  readonly fingerprint: string;
  readonly authorizationHeaderEncrypted: string;
  readonly upstream?: CapabilityUpstream;
  readonly accountIdEncrypted?: string;
  readonly providerConnection?: {
    readonly proxy: "codex" | "claude";
    readonly connectionId: ProviderConnectionId;
    readonly providerId: ProviderId;
    readonly authKind: AuthKind;
    readonly billingRoute: "subscription" | "api";
  };
  readonly expiresAt: number;
}

export interface AuthStateRecord {
  readonly subject: string;
  readonly version: number;
  readonly sessions: Readonly<Record<string, AuthSession>>;
  readonly credentials: Readonly<Record<string, StoredCredential>>;
}

export interface ManagedAuthSnapshot {
  readonly subject: string;
  readonly version: number;
  readonly issuedAt: number;
  readonly expiresAt: number;
  readonly capabilities: readonly string[];
  readonly credentialCapabilities: readonly {
    readonly provider: CapabilityProvider;
    readonly handle: string;
    readonly expiresAt: number;
  }[];
  readonly providerConnections: readonly ManagedProviderCapability[];
}

const MAX_SNAPSHOT_SECONDS = 5 * 60;

export const credentialStorageKey = (
  provider: CapabilityProvider,
  connectionId: ProviderConnectionId | null,
): string =>
  connectionId === null ? provider : `${provider}:${connectionId}`;

const activeCredentials = (
  state: AuthStateRecord,
  now: number,
): readonly StoredCredential[] =>
  Object.values(state.credentials).filter(
    (credential) => credential.expiresAt > now,
  );

export const emptyAuthState = (subject: string): AuthStateRecord => ({
  subject,
  version: 1,
  sessions: {},
  credentials: {},
});

export const removeExpired = (
  state: AuthStateRecord,
  now: number,
): AuthStateRecord => {
  const sessions = Object.fromEntries(
    Object.entries(state.sessions).filter(
      ([, session]) => session.expiresAt > now,
    ),
  );
  const credentials = Object.fromEntries(
    Object.values(state.credentials)
      .filter((credential) => credential.expiresAt > now)
      .map((credential) => [
        credentialStorageKey(
          credential.provider,
          credential.providerConnection?.connectionId ?? null,
        ),
        credential,
      ]),
  ) as AuthStateRecord["credentials"];
  const credentialsUnchanged =
    Object.keys(credentials).length === Object.keys(state.credentials).length &&
    Object.entries(credentials).every(
      ([key, credential]) => state.credentials[key] === credential,
    );
  if (
    Object.keys(sessions).length === Object.keys(state.sessions).length &&
    credentialsUnchanged
  ) {
    return state;
  }
  return { ...state, version: state.version + 1, sessions, credentials };
};

export const snapshotOf = (
  state: AuthStateRecord,
  now: number,
): ManagedAuthSnapshot => {
  const activeSessionExpiries = Object.values(state.sessions)
    .map((session) => session.expiresAt)
    .filter((expiresAt) => expiresAt > now);
  const authenticated = activeSessionExpiries.length > 0;
  const credentials = authenticated ? activeCredentials(state, now) : [];
  const credentialCapabilities = credentials.map(
    ({ provider, handle, expiresAt }) => ({ provider, handle, expiresAt }),
  );
  const providerConnections = credentials.flatMap((credential) =>
    credential.providerConnection === undefined
      ? []
      : [
          {
            version: 1 as const,
            ...credential.providerConnection,
            handle: credential.handle,
            expiresAt: credential.expiresAt,
          },
        ],
  );
  return {
    subject: state.subject,
    version: state.version,
    issuedAt: now,
    expiresAt: Math.min(
      now + MAX_SNAPSHOT_SECONDS,
      ...activeSessionExpiries,
      ...credentialCapabilities.map((credential) => credential.expiresAt),
    ),
    capabilities:
      authenticated &&
      credentialCapabilities.some(
        ({ provider }) => provider === "codex" || provider === "claude",
      )
        ? ["managed.session.execute"]
        : [],
    credentialCapabilities,
    providerConnections,
  };
};

export const resolveCredential = (
  state: AuthStateRecord,
  provider: CapabilityProvider,
  handle: string,
  now: number,
): StoredCredential | null => {
  if (!Object.values(state.sessions).some((session) => session.expiresAt > now))
    return null;
  return (
    activeCredentials(state, now).find(
      (credential) =>
        credential.provider === provider && credential.handle === handle,
    ) ?? null
  );
};
