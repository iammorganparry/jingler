import {
  ManagedProviderCapability,
  type ManagedProviderCapability as ManagedProviderCapabilityValue,
  type ProviderConnectionId as ProviderConnectionIdValue,
} from "@jingler/core";
import { Either, Schema } from "effect";

const MAX_CAPABILITIES = 32;
const MAX_ACTIVE_SESSIONS = 1;
const ACTIVE_SESSION_LEASE_SECONDS = 2 * 60 * 60;

const CredentialCapability = Schema.Struct({
  provider: Schema.Literal("github", "codex", "claude"),
  handle: Schema.String.pipe(Schema.minLength(1), Schema.maxLength(256)),
  expiresAt: Schema.Int.pipe(Schema.positive()),
});

const ManagedAuthSnapshotSchema = Schema.Struct({
  subject: Schema.String.pipe(Schema.minLength(1), Schema.maxLength(256)),
  version: Schema.Int.pipe(Schema.positive()),
  issuedAt: Schema.Int.pipe(Schema.positive()),
  expiresAt: Schema.Int.pipe(Schema.positive()),
  capabilities: Schema.Array(
    Schema.String.pipe(Schema.minLength(1), Schema.maxLength(256)),
  ).pipe(Schema.maxItems(MAX_CAPABILITIES)),
  credentialCapabilities: Schema.Array(CredentialCapability).pipe(
    Schema.maxItems(8),
  ),
  providerConnections: Schema.optionalWith(
    Schema.Array(ManagedProviderCapability).pipe(Schema.maxItems(8)),
    { default: () => [] },
  ),
});
export type ManagedAuthSnapshot = Schema.Schema.Type<
  typeof ManagedAuthSnapshotSchema
>;

export interface ManagedAuthSubscription {
  readonly leaseExpiresAt: number;
}

export interface ManagedAuthState {
  readonly snapshot: ManagedAuthSnapshot | null;
  readonly subscription: ManagedAuthSubscription | null;
  readonly activeSessionIds: readonly string[];
  readonly activeSessionLeases: Readonly<Record<string, number>>;
}

export type AuthorizationDecision =
  | { readonly admitted: true; readonly authStateVersion: number }
  | {
      readonly admitted: false;
      readonly reason: "auth-unavailable" | "auth-stale" | "capability-missing";
    };

export const decodeManagedAuthSnapshot = (
  value: unknown,
): ManagedAuthSnapshot | null => {
  const decoded = Schema.decodeUnknownEither(ManagedAuthSnapshotSchema)(value, {
    onExcessProperty: "error",
  });
  return Either.isRight(decoded) ? decoded.right : null;
};

export const emptyManagedAuthState = (): ManagedAuthState => ({
  snapshot: null,
  subscription: null,
  activeSessionIds: [],
  activeSessionLeases: {},
});

export const hasSameProviderRoute = (
  expected: ManagedProviderCapabilityValue,
  candidate: ManagedProviderCapabilityValue,
): boolean =>
  candidate.connectionId === expected.connectionId &&
  candidate.providerId === expected.providerId &&
  candidate.proxy === expected.proxy &&
  candidate.authKind === expected.authKind &&
  candidate.billingRoute === expected.billingRoute;

/** Pure coordinator state used by the Durable Object and deterministic tests. */
export class ManagedAuthSubscriptionLedger {
  readonly #subject: string;
  #state: ManagedAuthState;

  constructor(
    subject: string,
    restored:
      | ManagedAuthState
      | Omit<ManagedAuthState, "activeSessionLeases"> = emptyManagedAuthState(),
  ) {
    this.#subject = subject;
    this.#state = {
      ...restored,
      activeSessionLeases:
        "activeSessionLeases" in restored ? restored.activeSessionLeases : {},
    };
  }

  snapshot(): ManagedAuthState {
    return this.#state;
  }

  needsSubscription(now: number): boolean {
    return (
      this.#state.subscription === null ||
      this.#state.subscription.leaseExpiresAt <= now ||
      this.#state.snapshot === null ||
      this.#state.snapshot.expiresAt <= now
    );
  }

  registerSession(sessionId: string, now: number): { subscribe: boolean } {
    const activeSessionIds = this.#state.activeSessionIds.filter(
      (candidate) => (this.#state.activeSessionLeases[candidate] ?? 0) > now,
    );
    const activeSessionLeases = Object.fromEntries(
      activeSessionIds.map((candidate) => [
        candidate,
        this.#state.activeSessionLeases[candidate]!,
      ]),
    );
    this.#state = { ...this.#state, activeSessionIds, activeSessionLeases };
    if (!this.#state.activeSessionIds.includes(sessionId)) {
      if (this.#state.activeSessionIds.length >= MAX_ACTIVE_SESSIONS) {
        throw new Error("Managed session concurrency exceeded");
      }
      this.#state = {
        ...this.#state,
        activeSessionIds: [...this.#state.activeSessionIds, sessionId],
        activeSessionLeases: {
          ...this.#state.activeSessionLeases,
          [sessionId]: now + ACTIVE_SESSION_LEASE_SECONDS,
        },
      };
    } else {
      this.#state = {
        ...this.#state,
        activeSessionLeases: {
          ...this.#state.activeSessionLeases,
          [sessionId]: now + ACTIVE_SESSION_LEASE_SECONDS,
        },
      };
    }
    return { subscribe: this.needsSubscription(now) };
  }

  unregisterSession(sessionId: string): void {
    const { [sessionId]: _removed, ...activeSessionLeases } =
      this.#state.activeSessionLeases;
    this.#state = {
      ...this.#state,
      activeSessionIds: this.#state.activeSessionIds.filter(
        (candidate) => candidate !== sessionId,
      ),
      activeSessionLeases,
    };
  }

  apply(
    snapshot: ManagedAuthSnapshot,
    subscription: ManagedAuthSubscription,
  ): boolean {
    if (snapshot.subject !== this.#subject) return false;
    if (
      this.#state.snapshot !== null &&
      snapshot.version < this.#state.snapshot.version
    ) {
      return false;
    }
    this.#state = { ...this.#state, snapshot, subscription };
    return true;
  }

  disconnect(): void {
    this.#state = { ...this.#state, snapshot: null, subscription: null };
  }

  authorize(capability: string, now: number): AuthorizationDecision {
    if (this.#state.snapshot === null || this.#state.subscription === null) {
      return { admitted: false, reason: "auth-unavailable" };
    }
    if (this.needsSubscription(now)) {
      return { admitted: false, reason: "auth-stale" };
    }
    if (!this.#state.snapshot.capabilities.includes(capability)) {
      return { admitted: false, reason: "capability-missing" };
    }
    return {
      admitted: true,
      authStateVersion: this.#state.snapshot.version,
    };
  }

  credentialHandle(
    provider: "github" | "codex" | "claude",
    now: number,
  ): string | null {
    if (this.needsSubscription(now)) return null;
    return (
      this.#state.snapshot?.credentialCapabilities.find(
        (capability) =>
          capability.provider === provider && capability.expiresAt > now,
      )?.handle ?? null
    );
  }

  providerConnection(
    connectionId: ProviderConnectionIdValue,
    now: number,
  ): ManagedProviderCapabilityValue | null {
    if (this.needsSubscription(now)) return null;
    return (
      this.#state.snapshot?.providerConnections.find(
        (capability) =>
          capability.connectionId === connectionId &&
          capability.expiresAt > now,
      ) ?? null
    );
  }

  providerConnections(
    now: number,
  ): ReadonlyArray<ManagedProviderCapabilityValue> {
    if (this.needsSubscription(now)) return [];
    return (
      this.#state.snapshot?.providerConnections.filter(
        (capability) => capability.expiresAt > now,
      ) ?? []
    );
  }
}
