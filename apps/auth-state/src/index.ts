import { DurableObject } from "cloudflare:workers";
import {
  AuthKind,
  ManagedProviderProxy,
  ProviderConnectionId,
  ProviderId,
} from "@jingler/core";
import {
  readBoundedJson,
  workerFields as fields,
  workerJson as json,
} from "@jingler/core/worker-http";
import { Either, Schema } from "effect";
import { openCredential, sealCredential } from "./credential-envelope.js";
import {
  credentialStorageKey,
  emptyAuthState,
  removeExpired,
  resolveCredential,
  snapshotOf,
  type AuthSession,
  type AuthStateRecord,
  type CapabilityUpstream,
  type CapabilityProvider,
  type StoredCredential,
} from "./state.js";

interface AuthStateEnv {
  readonly AUTH_STATE: DurableObjectNamespace<AuthStateObject>;
  readonly AUTH_STATE_SERVICE_SECRET: string;
  readonly MANAGED_RUNTIME_CALLBACK_SECRET: string;
  readonly MANAGED_RUNTIME_ORIGIN: string;
  readonly AUTH_STATE_ENCRYPTION_KEY: string;
}

interface Subscriber {
  readonly id: string;
  readonly callbackUrl: string;
  readonly leaseExpiresAt: number;
}

const STATE_KEY = "auth-state";
const SUBSCRIBER_KEY = "managed-subscriber";
const SUBSCRIPTION_SECONDS = 5 * 60;
const SUBJECT_PATH = /^\/v1\/internal\/users\/([^/]+)(\/.*)?$/u;
const CODEX_ACCOUNT_ID = /^[0-9a-f-]{36}$/iu;
const Subject = Schema.String.pipe(Schema.minLength(1), Schema.maxLength(256));
const Identifier = Schema.String.pipe(Schema.minLength(1), Schema.maxLength(256));
const CapabilityProviderSchema = Schema.Literal("github", "codex", "claude");
const CapabilityUpstreamSchema = Schema.Literal(
  "github-api",
  "openai-api",
  "chatgpt-codex",
  "anthropic-api",
);
const SubjectInput = Schema.Struct({ subject: Subject });
const SubscriptionInput = Schema.Struct({
  subject: Subject,
  subscriberId: Identifier,
  callbackUrl: Schema.String,
});
const ResolveCapabilityInput = Schema.Struct({
  subject: Subject,
  provider: CapabilityProviderSchema,
  handle: Identifier,
  audience: Schema.Literal("managed-runtime-provider-proxy"),
});
const SessionInput = Schema.Struct({
  subject: Subject,
  sessionId: Identifier,
  expiresAt: Schema.Int,
});
const CapabilityInput = Schema.Struct({
  subject: Subject,
  provider: CapabilityProviderSchema,
  authorizationHeader: Schema.String,
  expiresAt: Schema.Int,
  upstream: Schema.optional(CapabilityUpstreamSchema),
  accountId: Schema.optional(Schema.String),
  proxy: Schema.optional(ManagedProviderProxy),
  connectionId: Schema.optional(ProviderConnectionId),
  providerId: Schema.optional(ProviderId),
  authKind: Schema.optional(AuthKind),
  billingRoute: Schema.optional(Schema.Literal("subscription", "api")),
});
const DeleteCapabilityInput = Schema.Struct({
  subject: Subject,
  provider: CapabilityProviderSchema,
});
const decode = <A, I>(
  schema: Schema.Schema<A, I, never>,
  value: unknown,
): A | null => {
  const decoded = Schema.decodeUnknownEither(schema)(value, {
    onExcessProperty: "ignore",
  });
  return Either.isRight(decoded) ? decoded.right : null;
};
const readBody = async (
  request: Request,
): Promise<Record<string, unknown> | null> => {
  try {
    return fields(await readBoundedJson(request));
  } catch {
    return null;
  }
};

const nowSeconds = (): number => Math.floor(Date.now() / 1_000);

const credentialFingerprint = async (
  authorizationHeader: string,
  upstream: CapabilityUpstream,
  accountId: string | null,
  connectionId: string | null,
): Promise<string> => {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(
      `${upstream}\n${accountId ?? ""}\n${connectionId ?? ""}\n${authorizationHeader}`,
    ),
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
};

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

interface ValidatedCapability {
  readonly provider: CapabilityProvider;
  readonly upstream: CapabilityUpstream;
  readonly authorizationHeader: string;
  readonly accountId: string | null;
  readonly expiresAt: number;
  readonly providerConnection?: ProviderConnectionCapabilityInput;
}

type CapabilityValidation =
  | { readonly ok: true; readonly value: ValidatedCapability }
  | { readonly ok: false; readonly error: string };

const hasSupportedAuthorization = (value: string): boolean =>
  value.startsWith("Bearer ") || value.startsWith("X-Api-Key ");

const hasValidAccountScope = (
  upstream: CapabilityUpstream,
  accountId: string | null,
): boolean =>
  upstream === "chatgpt-codex"
    ? accountId !== null && CODEX_ACCOUNT_ID.test(accountId)
    : accountId === null;

const validateCapability = (
  body: unknown,
  now: number,
): CapabilityValidation => {
  const input = decode(CapabilityInput, body);
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
      : decode(ProviderConnectionCapabilityInput, input);
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

const authorized = (request: Request, env: AuthStateEnv): boolean =>
  env.AUTH_STATE_SERVICE_SECRET.length >= 32 &&
  (request.headers.get("x-jingler-service-secret") ===
    env.AUTH_STATE_SERVICE_SECRET ||
    request.headers.get("authorization") ===
      `Bearer ${env.AUTH_STATE_SERVICE_SECRET}`);

const subjectPath = (
  pathname: string,
): { subject: string; suffix: string } | null => {
  const match = pathname.match(SUBJECT_PATH);
  if (match === null) return null;
  try {
    return {
      subject: decodeURIComponent(match[1] ?? ""),
      suffix: match[2] ?? "",
    };
  } catch {
    return null;
  }
};

/** Deterministically-routed per-user auth state; no account scans or polling. */
export class AuthStateObject extends DurableObject<AuthStateEnv> {
  async #state(subject: string): Promise<AuthStateRecord> {
    const stored = await this.ctx.storage.get<AuthStateRecord>(STATE_KEY);
    if (stored !== undefined && stored.subject !== subject) {
      throw new Error("Auth-state subject mismatch");
    }
    const current = removeExpired(
      stored ?? emptyAuthState(subject),
      nowSeconds(),
    );
    if (current !== stored) await this.ctx.storage.put(STATE_KEY, current);
    return current;
  }

  async #put(state: AuthStateRecord): Promise<void> {
    await this.ctx.storage.put(STATE_KEY, state);
    const expiries = [
      ...Object.values(state.sessions).map(({ expiresAt }) => expiresAt),
      ...Object.values(state.credentials)
        .filter(
          (credential): credential is StoredCredential =>
            credential !== undefined,
        )
        .map(({ expiresAt }) => expiresAt),
    ].filter((expiresAt) => expiresAt > nowSeconds());
    if (expiries.length > 0) {
      await this.ctx.storage.setAlarm(Math.min(...expiries) * 1_000);
    }
  }

  async #notify(state: AuthStateRecord): Promise<void> {
    const subscriber = await this.ctx.storage.get<Subscriber>(SUBSCRIBER_KEY);
    const now = nowSeconds();
    if (subscriber === undefined || subscriber.leaseExpiresAt <= now) return;
    await fetch(subscriber.callbackUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-jingler-service-secret": this.env.MANAGED_RUNTIME_CALLBACK_SECRET,
      },
      body: JSON.stringify({
        snapshot: snapshotOf(state, now),
        leaseExpiresAt: subscriber.leaseExpiresAt,
      }),
    }).catch(() => undefined);
  }

  override async alarm(): Promise<void> {
    const stored = await this.ctx.storage.get<AuthStateRecord>(STATE_KEY);
    if (stored === undefined) return;
    const current = removeExpired(stored, nowSeconds());
    if (current !== stored) {
      await this.#put(current);
      await this.#notify(current);
    }
  }

  async #persist(state: AuthStateRecord): Promise<Response> {
    await this.#put(state);
    await this.#notify(state);
    return json({ ok: true, version: state.version });
  }

  async #subscribe(body: unknown, state: AuthStateRecord): Promise<Response> {
    const input = decode(SubscriptionInput, body);
    if (input === null) {
      return json(
        { error: "subscriberId and callbackUrl are required" },
        400,
      );
    }
    let callback: URL;
    try {
      callback = new URL(input.callbackUrl);
    } catch {
      return json({ error: "Invalid callback URL" }, 400);
    }
    if (callback.origin !== this.env.MANAGED_RUNTIME_ORIGIN) {
      return json({ error: "Callback origin is not allowed" }, 400);
    }
    const leaseExpiresAt = nowSeconds() + SUBSCRIPTION_SECONDS;
    await this.ctx.storage.put<Subscriber>(SUBSCRIBER_KEY, {
      id: input.subscriberId,
      callbackUrl: input.callbackUrl,
      leaseExpiresAt,
    });
    return json({ snapshot: snapshotOf(state, nowSeconds()), leaseExpiresAt });
  }

  async #resolveCapability(
    body: unknown,
    state: AuthStateRecord,
  ): Promise<Response> {
    const input = decode(ResolveCapabilityInput, body);
    if (input === null)
      return json({ error: "Invalid capability request" }, 400);
    const credential = resolveCredential(
      state,
      input.provider,
      input.handle,
      nowSeconds(),
    );
    if (credential === null)
      return json({ error: "Capability unavailable" }, 403);
    return json({
      authorizationHeader: await openCredential(
        credential.authorizationHeaderEncrypted,
        this.env.AUTH_STATE_ENCRYPTION_KEY,
      ),
      upstream:
        credential.upstream ??
        (credential.provider === "github" ? "github-api" : "openai-api"),
      ...(credential.accountIdEncrypted === undefined
        ? {}
        : {
            accountId: await openCredential(
              credential.accountIdEncrypted,
              this.env.AUTH_STATE_ENCRYPTION_KEY,
            ),
          }),
    });
  }

  async #upsertSession(
    body: unknown,
    state: AuthStateRecord,
  ): Promise<Response> {
    const input = decode(SessionInput, body);
    if (input === null) return json({ error: "Invalid session" }, 400);
    const session: AuthSession = {
      id: input.sessionId,
      expiresAt: input.expiresAt,
    };
    return this.#persist({
      ...state,
      version: state.version + 1,
      sessions: { ...state.sessions, [session.id]: session },
    });
  }

  async #deleteSession(
    body: unknown,
    state: AuthStateRecord,
  ): Promise<Response> {
    const input = decode(SessionInput, body);
    if (input === null) return json({ error: "Invalid session" }, 400);
    if (state.sessions[input.sessionId] === undefined) {
      return json({ ok: true, version: state.version });
    }
    const { [input.sessionId]: _removed, ...sessions } = state.sessions;
    return this.#persist({
      ...state,
      version: state.version + 1,
      sessions,
    });
  }

  async #sealCapability(
    input: ValidatedCapability,
    fingerprint: string,
    existing: StoredCredential | undefined,
  ): Promise<StoredCredential> {
    return {
      provider: input.provider,
      handle:
        existing?.fingerprint === fingerprint
          ? existing.handle
          : `capability_${crypto.randomUUID().replaceAll("-", "")}`,
      fingerprint,
      upstream: input.upstream,
      authorizationHeaderEncrypted: await sealCredential(
        input.authorizationHeader,
        this.env.AUTH_STATE_ENCRYPTION_KEY,
      ),
      ...(input.accountId === null
        ? {}
        : {
            accountIdEncrypted: await sealCredential(
              input.accountId,
              this.env.AUTH_STATE_ENCRYPTION_KEY,
            ),
          }),
      ...(input.providerConnection === undefined
        ? {}
        : { providerConnection: input.providerConnection }),
      expiresAt: input.expiresAt,
    };
  }

  async #upsertCapability(
    body: unknown,
    state: AuthStateRecord,
  ): Promise<Response> {
    const validated = validateCapability(body, nowSeconds());
    if (!validated.ok) return json({ error: validated.error }, 400);
    const input = validated.value;
    const connectionId = input.providerConnection?.connectionId ?? null;
    const storageKey = credentialStorageKey(input.provider, connectionId);
    const fingerprint = await credentialFingerprint(
      input.authorizationHeader,
      input.upstream,
      input.accountId,
      connectionId,
    );
    const existing = state.credentials[storageKey];
    if (
      existing?.fingerprint === fingerprint &&
      existing.expiresAt > nowSeconds() + 6 * 60 * 60
    ) {
      return json({
        ok: true,
        version: state.version,
        handle: existing.handle,
      });
    }
    const credential = await this.#sealCapability(
      input,
      fingerprint,
      existing,
    );
    const next = {
      ...state,
      version: state.version + 1,
      credentials: { ...state.credentials, [storageKey]: credential },
    };
    await this.#put(next);
    await this.#notify(next);
    return json({ ok: true, version: next.version, handle: credential.handle });
  }

  async #deleteCapability(
    body: unknown,
    state: AuthStateRecord,
  ): Promise<Response> {
    const input = decode(DeleteCapabilityInput, body);
    if (input === null) return json({ error: "Invalid capability" }, 400);
    const credentials = Object.fromEntries(
      Object.entries(state.credentials).filter(
        ([, credential]) => credential.provider !== input.provider,
      ),
    );
    if (
      Object.keys(credentials).length === Object.keys(state.credentials).length
    ) {
      return json({ ok: true, version: state.version });
    }
    return this.#persist({
      ...state,
      version: state.version + 1,
      credentials,
    });
  }

  #route(
    request: Request,
    body: unknown,
    state: AuthStateRecord,
  ): Promise<Response> | Response {
    switch (`${request.method} ${new URL(request.url).pathname}`) {
      case "POST /v1/subscriptions/managed-runtime":
        return this.#subscribe(body, state);
      case "POST /v1/capabilities/resolve":
        return this.#resolveCapability(body, state);
      case "PUT /v1/internal/session":
        return this.#upsertSession(body, state);
      case "DELETE /v1/internal/session":
        return this.#deleteSession(body, state);
      case "PUT /v1/internal/capability":
        return this.#upsertCapability(body, state);
      case "DELETE /v1/internal/capability":
        return this.#deleteCapability(body, state);
      default:
        return json({ error: "Not found" }, 404);
    }
  }

  override async fetch(request: Request): Promise<Response> {
    if (!authorized(request, this.env))
      return json({ error: "Unauthorized" }, 401);
    const body =
      request.method === "POST" ||
      request.method === "PUT" ||
      request.method === "DELETE"
        ? await readBody(request)
        : null;
    const subject = decode(SubjectInput, body)?.subject ?? null;
    if (subject === null) {
      return json({ error: "subject is required" }, 400);
    }
    const state = await this.#state(subject);
    return this.#route(request, body, state);

  }
}

export default {
  async fetch(request: Request, env: AuthStateEnv): Promise<Response> {
    if (new URL(request.url).pathname === "/health") {
      return json({ status: "ok", service: "@jingler/auth-state" });
    }
    if (!authorized(request, env)) return json({ error: "Unauthorized" }, 401);
    const parsed = subjectPath(new URL(request.url).pathname);
    if (
      parsed === null ||
      parsed.subject.length === 0 ||
      parsed.subject.length > 256
    ) {
      return json({ error: "Not found" }, 404);
    }
    return env.AUTH_STATE.getByName(parsed.subject).fetch(
      `https://auth-state.internal/v1/internal${parsed.suffix}`,
      {
        method: request.method,
        headers: {
          "content-type": "application/json",
          "x-jingler-service-secret": env.AUTH_STATE_SERVICE_SECRET,
        },
        body:
          request.method === "GET" || request.method === "HEAD"
            ? undefined
            : JSON.stringify({
                ...(await readBody(request)),
                subject: parsed.subject,
              }),
      },
    );
  },
};
