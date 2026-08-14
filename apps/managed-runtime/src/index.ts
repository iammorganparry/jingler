import { getSandbox } from "@cloudflare/sandbox";
import type {
  ManagedProviderCapability as ManagedProviderCapabilityValue,
  OffloadAdmissionRequest as OffloadAdmissionRequestValue,
  OffloadGrantAction
} from "@jingler/core";
import {
  OFFLOAD_SNAPSHOT_MAX_BYTES,
  OffloadAdmissionRequest,
  ManagedProviderCapability,
  ManagedRuntimeProviderSelection,
  WorkspaceProvisioningPlan,
} from "@jingler/core";
import { Effect, Either, Schema } from "effect";
import {
  claimsManagedSessionSlot,
  decodeManagedGrantRequest,
} from "./grant-request.js";
import { matchesGitRepositoryScope } from "./git-scope.js";
import { issueManagedRuntimeGrant } from "./grant.js";
import { hydrateWorkspace } from "./workspace-hydration.js";
import {
  createWorkspaceCheckpoint,
  restoreWorkspaceCheckpoint,
} from "./workspace-checkpoint.js";
import {
  createControlPlaneProviderFetch,
  providerAuthorizationScope,
  proxyProviderRequest,
  resolveProviderCredential,
} from "./provider-proxy.js";
import {
  managedRuntimeSandboxOrigin,
  type ManagedRuntimeEnv,
} from "./runtime-env.js";
import { r2CheckpointStore } from "./r2-checkpoint-store.js";
import { json } from "./worker-http.js";
import { INTERNAL_ROUTES } from "./internal-routes.js";
import {
  destroyRuntimeSession,
  unregisterRuntimeSession,
} from "./runtime-cleanup.js";
import {
  runtimeConfigurationForRegistration,
  type RuntimeRegistrationInput,
} from "./runtime-configuration.js";
import { sandboxIdForSession, sha256Hex } from "./runtime-identity.js";
import {
  bearerOffloadGrant,
  issueOffloadGrant,
  verifyOffloadGrant
} from "./offload-grant.js";
import {
  OffloadJobStore,
  OffloadStoreError,
  makeOffloadJobStoreLayer
} from "./offload-store.js";
import { primeOffloadWorkspace } from "./offload-workspace.js";

export { Sandbox } from "@cloudflare/sandbox";
export { ManagedAccountObject } from "./account-runtime.js";
export { ManagedSessionObject } from "./session-runtime.js";
export { OffloadComputeWorkflow } from "./offload-workflow.js";
export { OffloadSandboxLifecycleObject } from "./offload-sandbox-lifecycle.js";

const hasServiceAuthorization = (
  request: Request,
  env: ManagedRuntimeEnv,
): boolean =>
  env.MANAGED_RUNTIME_SERVICE_SECRET.length >= 32 &&
  request.headers.get("x-jingler-service-secret") ===
    env.MANAGED_RUNTIME_SERVICE_SECRET;

const hasBearerServiceAuthorization = (
  request: Request,
  env: ManagedRuntimeEnv,
): boolean =>
  env.MANAGED_RUNTIME_SERVICE_SECRET.length >= 32 &&
  request.headers.get("authorization") ===
    `Bearer ${env.MANAGED_RUNTIME_SERVICE_SECRET}`;

const ManagedIdentity = Schema.Struct({
  subject: Schema.String.pipe(Schema.minLength(1), Schema.maxLength(256)),
  environmentId: Schema.String.pipe(Schema.minLength(1), Schema.maxLength(128)),
});
const ManagedSessionIdentity = Schema.Struct({
  ...ManagedIdentity.fields,
  sessionId: Schema.String.pipe(Schema.minLength(1), Schema.maxLength(128)),
});
const ManagedWorkspaceHydrationRequest = Schema.Struct({
  version: Schema.Literal(1),
  ...ManagedSessionIdentity.fields,
  environmentGeneration: Schema.Int.pipe(Schema.positive()),
  ...ManagedRuntimeProviderSelection.fields,
  plan: WorkspaceProvisioningPlan,
  repositoryUrl: Schema.String.pipe(
    Schema.minLength(1),
    Schema.maxLength(2_048),
  ),
});

const decodeOrNull = <A, I>(
  schema: Schema.Schema<A, I>,
  value: unknown,
): A | null => {
  const decoded = Schema.decodeUnknownEither(schema)(value, {
    onExcessProperty: "error",
  });
  return Either.isRight(decoded) ? decoded.right : null;
};

interface RuntimeRegistration {
  readonly authStateVersion: number;
  readonly sessionGeneration: number;
  readonly providerConnection: ManagedProviderCapabilityValue;
  readonly githubCapabilityHandle: string | null;
}

const AccountRegistration = Schema.Struct({
  connected: Schema.Boolean,
  auth: Schema.Struct({
    admitted: Schema.Literal(true),
    authStateVersion: Schema.Int.pipe(Schema.positive()),
  }),
  providerConnections: Schema.Array(ManagedProviderCapability).pipe(
    Schema.minItems(1),
    Schema.maxItems(8),
  ),
  githubCapabilityHandle: Schema.NullOr(
    Schema.String.pipe(Schema.minLength(1), Schema.maxLength(256)),
  ),
});

const SessionRegistration = Schema.Struct({
  sessionGeneration: Schema.Int.pipe(Schema.positive()),
});
const GitTokenResponse = Schema.Struct({
  token: Schema.String.pipe(Schema.minLength(1), Schema.maxLength(16_384)),
});

class RuntimeRegistrationError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "RuntimeRegistrationError";
    this.status = status;
  }
}

const runtimeRegistration = async (
  env: ManagedRuntimeEnv,
  input: RuntimeRegistrationInput,
  claimSlot: boolean,
): Promise<RuntimeRegistration> => {
  const accountResponse = await env.MANAGED_ACCOUNT.getByName(
    input.subject,
  ).fetch(INTERNAL_ROUTES.managedAccount.sessionRegister, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      subject: input.subject,
      sessionId: input.sessionId,
      claimSlot,
    }),
  });
  if (!accountResponse.ok) {
    throw new RuntimeRegistrationError(
      accountResponse.status,
      accountResponse.status === 429
        ? "Managed session concurrency exceeded"
        : "Managed execution is not authorized",
    );
  }
  const releaseRegistration = () =>
    unregisterRuntimeSession(env, input.subject, input.sessionId).catch(
      () => undefined,
    );
  let accountBody: unknown;
  try {
    accountBody = await accountResponse.json();
  } catch {
    await releaseRegistration();
    throw new RuntimeRegistrationError(
      502,
      "Managed account registration was invalid",
    );
  }
  const decodedAccount = Schema.decodeUnknownEither(AccountRegistration)(
    accountBody,
    {
      onExcessProperty: "error",
    },
  );
  if (Either.isLeft(decodedAccount)) {
    await releaseRegistration();
    throw new RuntimeRegistrationError(
      403,
      "Managed execution is not authorized",
    );
  }
  const account = decodedAccount.right;
  const providerConnection = account.providerConnections.find(
    (candidate) =>
      candidate.connectionId === input.connectionId &&
      candidate.providerId === input.providerId,
  );
  if (providerConnection === undefined) {
    await releaseRegistration();
    throw new RuntimeRegistrationError(
      403,
      "Selected provider connection is unavailable",
    );
  }
  const sessionResponse = await env.MANAGED_SESSION.getByName(
    input.sessionId,
  ).fetch("https://managed-session.internal/v1/configure", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(
      runtimeConfigurationForRegistration(input, {
        authStateVersion: account.auth.authStateVersion,
        providerConnection,
        githubCapabilityHandle: account.githubCapabilityHandle,
      }),
    ),
  });
  if (!sessionResponse.ok) {
    await releaseRegistration();
    throw new RuntimeRegistrationError(
      sessionResponse.status >= 400 && sessionResponse.status < 600
        ? sessionResponse.status
        : 503,
      "Managed session registration failed",
    );
  }
  const session = Schema.decodeUnknownEither(SessionRegistration)(
    await sessionResponse.json(),
    { onExcessProperty: "error" },
  );
  if (Either.isLeft(session)) {
    await releaseRegistration();
    throw new RuntimeRegistrationError(
      502,
      "Managed session registration was invalid",
    );
  }
  return {
    authStateVersion: account.auth.authStateVersion,
    sessionGeneration: session.right.sessionGeneration,
    providerConnection,
    githubCapabilityHandle: account.githubCapabilityHandle,
  };
};

const OffloadRuntimeGrantRequest = Schema.Struct({
  subject: Schema.String.pipe(Schema.minLength(1), Schema.maxLength(256)),
  ...OffloadAdmissionRequest.fields
});
const OffloadPrimeRequest = Schema.Struct({
  subject: Schema.String.pipe(Schema.minLength(1), Schema.maxLength(256)),
  sessionId: OffloadAdmissionRequest.fields.sessionId,
  repositorySlug: OffloadAdmissionRequest.fields.repositorySlug,
  headSha: OffloadAdmissionRequest.fields.snapshot.fields.headSha
});
const OffloadSandboxDestroyRequest = Schema.Struct({
  subject: Schema.String.pipe(Schema.minLength(1), Schema.maxLength(256)),
  sessionId: Schema.String.pipe(Schema.minLength(1), Schema.maxLength(128))
});
const OffloadAccountRegistration = Schema.Struct({
  authStateVersion: Schema.Int.pipe(Schema.positive()),
  githubCapabilityHandle: Schema.String.pipe(Schema.minLength(1), Schema.maxLength(256))
});

const offloadJobId = async (subject: string, idempotencyKey: string): Promise<string> =>
  `job_${(await sha256Hex(`${subject}:${idempotencyKey}`)).slice(0, 40)}`;

const bytesDigest = async (bytes: Uint8Array): Promise<string> => {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
};

const registerOffloadJob = async (
  env: ManagedRuntimeEnv,
  subject: string,
  jobId: string,
  idempotencyKey: string
): Promise<Schema.Schema.Type<typeof OffloadAccountRegistration>> => {
  const response = await env.MANAGED_ACCOUNT.getByName(subject).fetch(
    INTERNAL_ROUTES.managedAccount.offloadRegister,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ subject, jobId, idempotencyKey })
    }
  );
  if (!response.ok) {
    throw new RuntimeRegistrationError(
      response.status,
      response.status === 429
        ? "Offload concurrency exceeded"
        : "Offload execution is not authorized"
    );
  }
  return Schema.decodeUnknownSync(OffloadAccountRegistration)(await response.json(), {
    onExcessProperty: "error"
  });
};

const authorizeOffloadPrimer = async (
  env: ManagedRuntimeEnv,
  subject: string
): Promise<Schema.Schema.Type<typeof OffloadAccountRegistration>> => {
  const response = await env.MANAGED_ACCOUNT.getByName(subject).fetch(
    INTERNAL_ROUTES.managedAccount.offloadAuthorize,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ subject })
    }
  );
  if (!response.ok) throw new Error("Offload primer is not authorized");
  return Schema.decodeUnknownSync(OffloadAccountRegistration)(await response.json(), {
    onExcessProperty: "error"
  });
};

const primeOffloadSession = async (
  env: ManagedRuntimeEnv,
  body: Schema.Schema.Type<typeof OffloadPrimeRequest>
): Promise<void> => {
  await authorizeOffloadPrimer(env, body.subject);
  await env.OFFLOAD_SANDBOX_LIFECYCLE.getByName(body.sessionId).fetch(
    INTERNAL_ROUTES.offloadLifecycle.touch,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ subject: body.subject, sessionId: body.sessionId })
    }
  );
  const sandbox = getSandbox(
    env.Sandbox,
    await sandboxIdForSession(`offload_${body.sessionId}`),
    {
      transport: "rpc",
      normalizeId: true,
      enableDefaultSession: false,
      sleepAfter: "10m"
    }
  );
  await Effect.runPromise(primeOffloadWorkspace(sandbox));
};

const authorizeOffloadRequest = (
  request: Request,
  env: ManagedRuntimeEnv,
  action: OffloadGrantAction,
  jobId: string,
  consume: boolean
) =>
  Effect.gen(function* () {
    const store = yield* OffloadJobStore;
    const record = yield* store.get(jobId);
    const verified = yield* verifyOffloadGrant(
      bearerOffloadGrant(request),
      env.MANAGED_RUNTIME_GRANT_SECRET,
      {
        action,
        subject: record.subject,
        sessionId: record.request.sessionId,
        jobId: record.jobId,
        repositorySlug: record.request.repositorySlug,
        snapshotDigest: record.request.snapshot.digest
      }
    );
    if (!verified.ok) return null;
    if (consume) {
      const consumed = yield* Effect.tryPromise(() =>
        env.MANAGED_ACCOUNT.getByName(record.subject).fetch(
          INTERNAL_ROUTES.managedAccount.offloadConsumeGrant,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              subject: record.subject,
              use: `${verified.claims.grantId}:${action}`
            })
          }
        )
      );
      if (!consumed.ok) return null;
    }
    return { record, claims: verified.claims };
  }).pipe(Effect.provide(makeOffloadJobStoreLayer(env.OFFLOAD_JOBS)));

const createOffloadWorkflowOnce = async (
  workflow: ManagedRuntimeEnv["OFFLOAD_WORKFLOW"],
  jobId: string
): Promise<void> => {
  try {
    await workflow.create({
      id: jobId,
      params: { jobId },
      retention: { successRetention: "1 day", errorRetention: "1 day" }
    });
  } catch (creationError) {
    try {
      await workflow.get(jobId);
    } catch {
      throw creationError;
    }
  }
};

export default {
  async fetch(
    request: Request,
    env: ManagedRuntimeEnv,
    ctx: ExecutionContext
  ): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/health") {
      return json({
        status: "ok",
        service: "@jingler/managed-runtime",
        serviceAuthorizationConfigured:
          typeof env.MANAGED_RUNTIME_SERVICE_SECRET === "string" &&
          env.MANAGED_RUNTIME_SERVICE_SECRET.length >= 32,
      });
    }
    if (url.pathname === "/v1/offload/prime" && request.method === "POST") {
      if (!hasBearerServiceAuthorization(request, env)) {
        return json({ error: "Unauthorized" }, 401);
      }
      const body = decodeOrNull(OffloadPrimeRequest, await request.json());
      if (body === null) return json({ error: "Invalid offload prime request" }, 400);
      ctx.waitUntil(
        primeOffloadSession(env, body).catch((cause) =>
          console.error("Offload primer failed", cause)
        )
      );
      return json({ accepted: true }, 202);
    }
    if (
      url.pathname === "/v1/offload/sandboxes/destroy" &&
      request.method === "POST"
    ) {
      if (!hasBearerServiceAuthorization(request, env)) {
        return json({ error: "Unauthorized" }, 401);
      }
      const body = decodeOrNull(OffloadSandboxDestroyRequest, await request.json());
      if (body === null) return json({ error: "Invalid sandbox cleanup request" }, 400);
      const response = await env.OFFLOAD_SANDBOX_LIFECYCLE.getByName(
        body.sessionId
      ).fetch(INTERNAL_ROUTES.offloadLifecycle.destroy, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body)
      });
      return response.ok
        ? json({ destroyed: true })
        : json({ error: "Sandbox cleanup failed" }, 503);
    }
    if (url.pathname === "/v1/offload/grants" && request.method === "POST") {
      if (!hasBearerServiceAuthorization(request, env)) {
        return json({ error: "Unauthorized" }, 401);
      }
      const body = decodeOrNull(OffloadRuntimeGrantRequest, await request.json());
      if (body === null) return json({ error: "Invalid offload grant request" }, 400);
      const jobId = await offloadJobId(body.subject, body.idempotencyKey);
      let registration: Schema.Schema.Type<typeof OffloadAccountRegistration>;
      try {
        registration = await registerOffloadJob(
          env,
          body.subject,
          jobId,
          body.idempotencyKey
        );
      } catch (cause) {
        return cause instanceof RuntimeRegistrationError
          ? json({ error: cause.message }, cause.status)
          : json({ error: "Offload registration failed" }, 503);
      }
      const requestFields: OffloadAdmissionRequestValue = {
        version: body.version,
        sessionId: body.sessionId,
        idempotencyKey: body.idempotencyKey,
        repositorySlug: body.repositorySlug,
        snapshot: body.snapshot,
        command: body.command,
        limits: body.limits
      };
      try {
        await Effect.runPromise(
          Effect.gen(function* () {
            const store = yield* OffloadJobStore;
            yield* store.create({
              jobId,
              subject: body.subject,
              request: requestFields,
              githubCapabilityHandle: registration.githubCapabilityHandle,
              nowSeconds: Math.floor(Date.now() / 1_000)
            });
          }).pipe(Effect.provide(makeOffloadJobStoreLayer(env.OFFLOAD_JOBS)))
        );
        await createOffloadWorkflowOnce(env.OFFLOAD_WORKFLOW, jobId);
        const issued = await Effect.runPromise(issueOffloadGrant(
          {
            subject: body.subject,
            sessionId: body.sessionId,
            jobId,
            idempotencyKey: body.idempotencyKey,
            repositorySlug: body.repositorySlug,
            snapshotDigest: body.snapshot.digest,
            actions: ["snapshot.upload", "job.read", "job.cancel"]
          },
          env.MANAGED_RUNTIME_GRANT_SECRET
        ));
        return json({
          version: 1,
          jobId,
          runtimeUrl: env.MANAGED_RUNTIME_ORIGIN,
          uploadUrl: `${env.MANAGED_RUNTIME_ORIGIN}/v1/offload/jobs/${encodeURIComponent(jobId)}/snapshot`,
          grant: issued.grant,
          expiresAt: issued.claims.expiresAt
        });
      } catch (cause) {
        return cause instanceof OffloadStoreError && cause.reason === "conflict"
          ? json({ error: cause.message }, 409)
          : json({ error: "Offload grant could not be issued" }, 503);
      }
    }
    if (url.pathname === "/v1/grants" && request.method === "POST") {
      if (!hasBearerServiceAuthorization(request, env)) {
        return json({ error: "Unauthorized" }, 401);
      }
      const input = decodeManagedGrantRequest(await request.json());
      if (input === null) return json({ error: "Invalid grant request" }, 400);
      let registration: RuntimeRegistration;
      try {
        registration = await runtimeRegistration(
          env,
          input,
          claimsManagedSessionSlot(input.actions),
        );
      } catch (cause) {
        return cause instanceof RuntimeRegistrationError
          ? json({ error: cause.message }, cause.status)
          : json({ error: "Managed execution registration failed" }, 503);
      }
      const issued = await issueManagedRuntimeGrant(
        {
          ...input,
          authStateVersion: registration.authStateVersion,
          sessionGeneration: registration.sessionGeneration,
        },
        env.MANAGED_RUNTIME_GRANT_SECRET,
      );
      return json({
        version: 1,
        runtimeUrl: env.MANAGED_RUNTIME_ORIGIN,
        grant: issued.grant,
        expiresAt: issued.claims.expiresAt,
      });
    }
    if (url.pathname === "/v1/offload-benchmark" && request.method === "POST") {
      if (!hasServiceAuthorization(request, env)) {
        return json({ error: "Unauthorized" }, 401);
      }
      const suffix = crypto.randomUUID().replaceAll("-", "");
      const sandbox = getSandbox(env.Sandbox, `offload-benchmark-${suffix}`, {
        transport: "rpc",
        normalizeId: true,
        enableDefaultSession: false,
        sleepAfter: "2m"
      });
      try {
        const coldStarted = Date.now();
        const cold = await sandbox.exec("printf cold-ready", {
          cwd: "/workspace",
          timeout: 30_000,
          origin: "internal"
        });
        const coldMs = Date.now() - coldStarted;
        const warmStarted = Date.now();
        const warm = await sandbox.exec("printf warm-ready", {
          cwd: "/workspace",
          timeout: 30_000,
          origin: "internal"
        });
        const warmMs = Date.now() - warmStarted;
        return json({
          success: cold.success && warm.success,
          coldMs,
          warmMs
        }, cold.success && warm.success ? 200 : 500);
      } finally {
        await sandbox.destroy().catch(() => undefined);
      }
    }
    if (url.pathname === "/v1/offload-probe" && request.method === "POST") {
      if (!hasServiceAuthorization(request, env)) {
        return json({ error: "Unauthorized" }, 401);
      }
      const suffix = crypto.randomUUID().replaceAll("-", "");
      const sessionId = `offload_probe_${suffix}`;
      const subject = "offload-probe";
      const key = `offload/probes/${suffix}.txt`;
      const lifecycle = env.OFFLOAD_SANDBOX_LIFECYCLE.getByName(sessionId);
      const sandbox = getSandbox(
        env.Sandbox,
        await sandboxIdForSession(`offload_${sessionId}`),
        {
          transport: "rpc",
          normalizeId: true,
          enableDefaultSession: false,
          sleepAfter: "2m"
        }
      );
      try {
        await env.OFFLOAD_JOBS.put(key, "offload-r2-ready");
        const stored = await env.OFFLOAD_JOBS.get(key);
        const image = await sandbox.exec(
          "test -x /opt/jingler/offload-exec.mjs -a -x /opt/jingler/offload-launch && node --version",
          { cwd: "/workspace", timeout: 30_000, origin: "internal" }
        );
        const isolation = await sandbox.exec(
          "printf locked > /workspace/offload-probe-source && chmod 0444 /workspace/offload-probe-source && /opt/jingler/offload-launch node -e \"const fs=require('node:fs'),net=require('node:net');let denied=0;try{fs.writeFileSync('/workspace/offload-probe-source','changed')}catch(e){if(e.code==='EACCES')denied++}const s=net.connect(443,'1.1.1.1');s.on('error',e=>{if(e.code==='EPERM')denied++;process.exit(denied===2?0:1)});setTimeout(()=>process.exit(2),2000)\"",
          { cwd: "/workspace", timeout: 30_000, origin: "internal" }
        );
        const touched = await lifecycle.fetch(INTERNAL_ROUTES.offloadLifecycle.touch, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ subject, sessionId })
        });
        const success = stored !== null && await stored.text() === "offload-r2-ready" &&
          image.success && isolation.success && touched.ok;
        return json({
          success,
          checks: {
            r2: stored !== null,
            sandboxImage: image.success,
            commandIsolation: isolation.success,
            lifecycle: touched.ok
          }
        }, success ? 200 : 500);
      } finally {
        await env.OFFLOAD_JOBS.delete(key).catch(() => undefined);
        await lifecycle.fetch(INTERNAL_ROUTES.offloadLifecycle.destroy, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ subject, sessionId })
        }).catch(() => undefined);
      }
    }
    if (url.pathname === "/v1/sandbox-probe" && request.method === "POST") {
      if (!hasServiceAuthorization(request, env)) {
        return json({ error: "Unauthorized" }, 401);
      }
      const sandbox = getSandbox(env.Sandbox, "probe", {
        transport: "rpc",
        normalizeId: true,
        enableDefaultSession: false,
        sleepAfter: "2m",
      });
      const result = await sandbox.exec("printf ready", { cwd: "/workspace" });
      await sandbox.destroy();
      return json({ success: result.success, output: result.stdout });
    }
    if (url.pathname === "/v1/checkpoint-probe" && request.method === "POST") {
      if (!hasServiceAuthorization(request, env)) {
        return json({ error: "Unauthorized" }, 401);
      }
      const suffix = crypto.randomUUID().replaceAll("-", "");
      const sessionId = `checkpoint_probe_${suffix}`;
      const checkpointId = `checkpoint_${suffix}`;
      const store = r2CheckpointStore(env.WORKSPACE_CHECKPOINTS);
      const sandboxId = await sandboxIdForSession(sessionId);
      let sandbox = getSandbox(env.Sandbox, sandboxId, {
        transport: "rpc",
        normalizeId: true,
        enableDefaultSession: false,
        sleepAfter: "2m",
      });
      let archiveKey: string | null = null;
      const manifestKey = `manifests/checkpoint-probe/${encodeURIComponent(sessionId)}/${encodeURIComponent(checkpointId)}.json`;
      try {
        const initialized = await sandbox.exec(
          "git init --initial-branch=main . && git config user.email probe@jingler.dev && git config user.name Jingler && printf checkpoint-ready > checkpoint.txt && git add checkpoint.txt && git commit -m base && printf dirty-state > dirty.txt",
          { cwd: "/workspace", timeout: 30_000 },
        );
        if (!initialized.success)
          throw new Error("Checkpoint probe setup failed");
        const created = await createWorkspaceCheckpoint(sandbox, store, {
          checkpointId,
          subject: "checkpoint-probe",
          environmentId: "managed-probe",
          sessionId,
          previousCheckpoint: null,
          eventCursor: 1,
          nowSeconds: Math.floor(Date.now() / 1_000),
          retentionSeconds: 300,
          maxBytes: 1_048_576,
        });
        archiveKey = created.manifest.backup.key;
        await sandbox.destroy();
        sandbox = getSandbox(env.Sandbox, sandboxId, {
          transport: "rpc",
          normalizeId: true,
          enableDefaultSession: false,
          sleepAfter: "2m",
        });
        await restoreWorkspaceCheckpoint(sandbox, store, created.manifest);
        const verified = await sandbox.exec(
          'test "$(cat checkpoint.txt)" = checkpoint-ready && test "$(cat dirty.txt)" = dirty-state && printf restored',
          { cwd: "/workspace", timeout: 30_000 },
        );
        return json(
          {
            success: verified.success,
            output: verified.stdout,
            checkpointId,
          },
          verified.success ? 200 : 500,
        );
      } catch (cause) {
        return json(
          {
            success: false,
            error:
              cause instanceof Error
                ? cause.message
                : "Checkpoint probe failed",
          },
          500,
        );
      } finally {
        await sandbox.destroy().catch(() => undefined);
        await env.WORKSPACE_CHECKPOINTS.delete(manifestKey).catch(
          () => undefined,
        );
        if (archiveKey !== null) {
          await env.WORKSPACE_CHECKPOINTS.delete(archiveKey).catch(
            () => undefined,
          );
        }
      }
    }
    if (
      url.pathname === "/v1/environments/destroy" &&
      request.method === "POST"
    ) {
      if (!hasBearerServiceAuthorization(request, env)) {
        return json({ error: "Unauthorized" }, 401);
      }
      const body = decodeOrNull(ManagedIdentity, await request.json());
      if (body === null)
        return json({ error: "Invalid environment cleanup request" }, 400);
      const account = env.MANAGED_ACCOUNT.getByName(body.subject);
      const listed = await account.fetch(
        INTERNAL_ROUTES.managedAccount.sessionList,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ subject: body.subject }),
        },
      );
      if (!listed.ok)
        return json({ error: "Managed session inventory unavailable" }, 503);
      const listedBody = (await listed.json()) as { sessionIds?: unknown };
      const sessionIds = Array.isArray(listedBody.sessionIds)
        ? listedBody.sessionIds.filter(
            (value): value is string => typeof value === "string",
          )
        : [];
      const results = await Promise.all(
        sessionIds.map((sessionId) =>
          env.MANAGED_SESSION.getByName(sessionId).fetch(
            "https://managed-session.internal/v1/destroy",
            {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify(body),
            },
          ),
        ),
      );
      if (results.some((response) => !response.ok && response.status !== 403)) {
        return json({ error: "Managed environment cleanup incomplete" }, 503);
      }
      return json({
        destroyed: results.filter((response) => response.ok).length,
      });
    }
    if (url.pathname === "/v1/sessions/destroy" && request.method === "POST") {
      if (!hasBearerServiceAuthorization(request, env)) {
        return json({ error: "Unauthorized" }, 401);
      }
      const body = decodeOrNull(ManagedSessionIdentity, await request.json());
      if (body === null)
        return json({ error: "Invalid session cleanup request" }, 400);
      await destroyRuntimeSession(env, body);
      return json({ destroyed: true });
    }
    if (
      url.pathname === "/v1/workspaces/hydrate" &&
      request.method === "POST"
    ) {
      if (!hasBearerServiceAuthorization(request, env)) {
        return json({ error: "Unauthorized" }, 401);
      }
      const body = decodeOrNull(
        ManagedWorkspaceHydrationRequest,
        await request.json(),
      );
      if (body === null) {
        return json({ error: "Invalid workspace hydration request" }, 400);
      }
      const sandbox = getSandbox(
        env.Sandbox,
        await sandboxIdForSession(body.sessionId),
        {
          transport: "rpc",
          normalizeId: true,
          enableDefaultSession: false,
          // Hydration can legitimately outlive the settled-session idle window:
          // a cold VM plus an exact-SHA Git fetch must remain active until the
          // workspace is ready. Subsequent session commands reapply the short
          // idle policy, and every failure path below destroys the sandbox.
          sleepAfter: `${env.MANAGED_RUNTIME_MAX_ACTIVE_SECONDS}s`,
        },
      );
      let registration: RuntimeRegistration;
      try {
        registration = await runtimeRegistration(
          env,
          {
            subject: body.subject,
            environmentId: body.environmentId,
            environmentGeneration: body.environmentGeneration,
            sessionId: body.sessionId,
            connectionId: body.connectionId,
            providerId: body.providerId,
            modelId: body.modelId,
            reservationId: null,
            repositorySlug: body.plan.repository.slug,
          },
          true,
        );
      } catch (cause) {
        return cause instanceof RuntimeRegistrationError
          ? json({ error: cause.message }, cause.status)
          : json({ error: "Managed workspace registration failed" }, 503);
      }
      const cleanup = () =>
        destroyRuntimeSession(env, {
          subject: body.subject,
          environmentId: body.environmentId,
          sessionId: body.sessionId,
        });
      const sessionStub = env.MANAGED_SESSION.getByName(body.sessionId);
      let gitAuthorization: string | undefined;
      if (registration.githubCapabilityHandle !== null) {
        const tokenResponse = await sessionStub.fetch(
          "https://managed-session.internal/v1/git-token",
          { method: "POST" },
        );
        if (!tokenResponse.ok) {
          await cleanup().catch(() => undefined);
          return json({ error: "GitHub authorization unavailable" }, 403);
        }
        const tokenFields = decodeOrNull(
          GitTokenResponse,
          await tokenResponse.json().catch(() => null),
        );
        if (tokenFields === null) {
          await cleanup().catch(() => undefined);
          return json({ error: "GitHub authorization unavailable" }, 403);
        }
        gitAuthorization = `Bearer ${tokenFields.token}`;
      }
      try {
        const repositorySlug = body.plan.repository.slug;
        const identity = await hydrateWorkspace(
          sandbox,
          body.plan,
          gitAuthorization === undefined
            ? body.repositoryUrl
            : `${managedRuntimeSandboxOrigin(env)}/v1/git/${encodeURIComponent(body.sessionId)}/${repositorySlug}.git`,
          {
            ...(gitAuthorization === undefined
              ? {}
              : { authorizationHeader: gitAuthorization }),
            canonicalRepositoryUrl: body.repositoryUrl,
          },
        );
        return json({ version: 1, identity });
      } catch (cause) {
        await cleanup().catch(async () => {
          await sandbox.destroy().catch(() => undefined);
          await unregisterRuntimeSession(
            env,
            body.subject,
            body.sessionId,
          ).catch(() => undefined);
        });
        return json(
          {
            error:
              cause instanceof Error
                ? cause.message
                : "Workspace hydration failed",
          },
          409,
        );
      } finally {
        if (gitAuthorization !== undefined) {
          await sessionStub.fetch(
            "https://managed-session.internal/v1/git-token/revoke",
            { method: "POST" },
          );
        }
      }
    }
    const offloadSnapshotMatch = url.pathname.match(
      /^\/v1\/offload\/jobs\/([^/]+)\/snapshot$/u
    );
    if (offloadSnapshotMatch !== null && request.method === "PUT") {
      const jobId = decodeURIComponent(offloadSnapshotMatch[1] ?? "");
      const authorized = await Effect.runPromise(
        authorizeOffloadRequest(request, env, "snapshot.upload", jobId, true).pipe(
          Effect.catchAll(() => Effect.succeed(null))
        )
      );
      if (authorized === null) return json({ error: "Offload upload denied" }, 403);
      const declared = Number(request.headers.get("x-jingler-snapshot-bytes") ?? 0);
      if (!request.body || !Number.isSafeInteger(declared) || declared < 1 || declared > OFFLOAD_SNAPSHOT_MAX_BYTES) {
        return json({ error: "Invalid offload snapshot length" }, 413);
      }
      const bytes = new Uint8Array(await request.arrayBuffer());
      if (bytes.byteLength !== declared || bytes.byteLength > OFFLOAD_SNAPSHOT_MAX_BYTES) {
        return json({ error: "Offload snapshot length changed" }, 413);
      }
      const digest = await bytesDigest(bytes);
      if (digest !== authorized.record.request.snapshot.digest) {
        return json({ error: "Offload snapshot digest mismatch" }, 409);
      }
      try {
        await Effect.runPromise(
          Effect.gen(function* () {
            const store = yield* OffloadJobStore;
            yield* store.putSnapshot(jobId, bytes, digest);
            yield* store.append(jobId, { kind: "state", state: "queued" });
          }).pipe(Effect.provide(makeOffloadJobStoreLayer(env.OFFLOAD_JOBS)))
        );
        await (await env.OFFLOAD_WORKFLOW.get(jobId)).sendEvent({
          type: "snapshot-ready",
          payload: { jobId }
        });
        return json({ accepted: true, jobId }, 202);
      } catch {
        return json({ error: "Offload workflow could not be started" }, 503);
      }
    }
    const offloadEventsMatch = url.pathname.match(
      /^\/v1\/offload\/jobs\/([^/]+)\/events$/u
    );
    if (offloadEventsMatch !== null && request.method === "GET") {
      const jobId = decodeURIComponent(offloadEventsMatch[1] ?? "");
      const authorized = await Effect.runPromise(
        authorizeOffloadRequest(request, env, "job.read", jobId, false).pipe(
          Effect.catchAll(() => Effect.succeed(null))
        )
      );
      if (authorized === null) return json({ error: "Offload read denied" }, 403);
      const cursor = Number(url.searchParams.get("cursor") ?? 0);
      if (!Number.isSafeInteger(cursor) || cursor < 0) {
        return json({ error: "Invalid event cursor" }, 400);
      }
      return json({
        version: 1,
        jobId,
        state: authorized.record.state,
        cursor: authorized.record.sequence,
        events: authorized.record.events.filter((event) => event.sequence > cursor),
        result: authorized.record.result
      });
    }
    const offloadCancelMatch = url.pathname.match(
      /^\/v1\/offload\/jobs\/([^/]+)\/cancel$/u
    );
    if (offloadCancelMatch !== null && request.method === "POST") {
      const jobId = decodeURIComponent(offloadCancelMatch[1] ?? "");
      const authorized = await Effect.runPromise(
        authorizeOffloadRequest(request, env, "job.cancel", jobId, true).pipe(
          Effect.catchAll(() => Effect.succeed(null))
        )
      );
      if (authorized === null) return json({ error: "Offload cancellation denied" }, 403);
      await Effect.runPromise(
        Effect.gen(function* () {
          const store = yield* OffloadJobStore;
          yield* store.requestCancel(jobId);
        }).pipe(Effect.provide(makeOffloadJobStoreLayer(env.OFFLOAD_JOBS)))
      );
      const sandbox = getSandbox(
        env.Sandbox,
        await sandboxIdForSession(`offload_${authorized.record.request.sessionId}`),
        {
          transport: "rpc",
          normalizeId: true,
          enableDefaultSession: false,
          sleepAfter: "10m"
        }
      );
      await sandbox.killAllProcesses().catch(() => undefined);
      await env.OFFLOAD_WORKFLOW.get(jobId).then(
        (instance) => instance.terminate(),
        () => undefined
      ).catch(() => undefined);
      const result = {
        version: 1 as const,
        jobId,
        state: "cancelled" as const,
        exitCode: null,
        failureReason: null,
        stdout: "",
        stderr: "",
        outputTruncated: false,
        timings: {
          queuedMs: 0,
          snapshotMs: 0,
          hydrationMs: 0,
          dependencyMs: 0,
          commandMs: 0
        }
      };
      await Effect.runPromise(
        Effect.gen(function* () {
          const store = yield* OffloadJobStore;
          yield* store.finish(jobId, result);
        }).pipe(Effect.provide(makeOffloadJobStoreLayer(env.OFFLOAD_JOBS)))
      );
      return json({ cancelled: true, jobId });
    }
    const offloadGitMatch = url.pathname.match(
      /^\/v1\/offload\/git\/([^/]+)\/([^/]+)\/([^/]+\.git)(\/.*)?$/u
    );
    if (
      offloadGitMatch !== null &&
      (request.method === "GET" || request.method === "POST")
    ) {
      const jobId = decodeURIComponent(offloadGitMatch[1] ?? "");
      const authorized = await Effect.runPromise(
        authorizeOffloadRequest(request, env, "git.read", jobId, false).pipe(
          Effect.catchAll(() => Effect.succeed(null))
        )
      );
      if (authorized === null) return json({ error: "Offload Git denied" }, 403);
      const owner = offloadGitMatch[2] ?? "";
      const repository = offloadGitMatch[3] ?? "";
      const suffix = offloadGitMatch[4] ?? "";
      if (!matchesGitRepositoryScope(owner, repository, authorized.record.request.repositorySlug)) {
        return json({ error: "Git repository scope denied" }, 403);
      }
      return proxyProviderRequest(
        {
          provider: "github",
          gitSmartHttp: true,
          subject: authorized.record.subject,
          capabilityHandle: authorized.record.githubCapabilityHandle,
          upstreamUrl: `https://github.com/${owner}/${repository}${suffix}${url.search}`,
          method: request.method,
          body: request.body,
          contentType: request.headers.get("content-type"),
          accept: request.headers.get("accept"),
          contentLength: Number(request.headers.get("content-length") ?? 0)
        },
        {
          resolve: (subject, handle) => resolveProviderCredential(env, subject, handle, "github"),
          fetch,
          maxEgressBytes: Number(env.MANAGED_RUNTIME_MAX_EGRESS_BYTES)
        }
      );
    }
    const providerProxyMatch = url.pathname.match(
      /^\/v1\/provider\/(codex|claude)\/([^/]+)(\/.*)$/u,
    );
    if (providerProxyMatch !== null) {
      const provider = providerProxyMatch[1] as "codex" | "claude";
      const sessionId = decodeURIComponent(providerProxyMatch[2] ?? "");
      const authorization = await env.MANAGED_SESSION.getByName(
        sessionId,
      ).fetch(
        `https://managed-session.internal/v1/provider-authorization/${provider}`,
        {
          method: "POST",
          headers: {
            authorization: request.headers.get("authorization") ?? "",
          },
        },
      );
      if (!authorization.ok) {
        console.warn(
          JSON.stringify({
            component: "managed-provider-proxy",
            event: "session_scope_denied",
            provider,
            status: authorization.status,
          }),
        );
        return json({ error: "Provider authorization unavailable" }, 403);
      }
      const scope = providerAuthorizationScope(await authorization.json());
      if (scope === null) {
        return json({ error: "Provider authorization unavailable" }, 403);
      }
      return proxyProviderRequest(
        {
          provider,
          subject: scope.subject,
          capabilityHandle: scope.capabilityHandle,
          upstreamUrl:
            provider === "codex"
              ? `https://api.openai.com${providerProxyMatch[3] ?? "/"}`
              : `https://api.anthropic.com${providerProxyMatch[3] ?? "/"}`,
          method: request.method === "GET" ? "GET" : "POST",
          body: request.body,
          contentType: request.headers.get("content-type"),
          contentEncoding: request.headers.get("content-encoding"),
          accept: request.headers.get("accept"),
          userAgent: request.headers.get("user-agent"),
          originator: request.headers.get("originator"),
          openAiBeta: request.headers.get("openai-beta"),
          anthropicBeta: request.headers.get("anthropic-beta"),
          sessionId: request.headers.get("session-id"),
          clientRequestId: request.headers.get("x-client-request-id"),
          contentLength: Number(request.headers.get("content-length") ?? 0),
        },
        {
          resolve: (subject, handle) =>
            resolveProviderCredential(env, subject, handle, provider),
          fetch: createControlPlaneProviderFetch({
            controlPlaneUrl: env.MANAGED_CONTROL_PLANE_URL,
            serviceSecret: env.MANAGED_RUNTIME_SERVICE_SECRET,
            fetch,
          }),
          maxEgressBytes: Number(env.MANAGED_RUNTIME_MAX_EGRESS_BYTES),
        },
      );
    }
    const gitProxyMatch = url.pathname.match(
      /^\/v1\/git\/([^/]+)\/([^/]+)\/([^/]+\.git)(\/.*)?$/u,
    );
    if (
      gitProxyMatch !== null &&
      (request.method === "GET" || request.method === "POST")
    ) {
      const sessionId = decodeURIComponent(gitProxyMatch[1] ?? "");
      const authorization = await env.MANAGED_SESSION.getByName(
        sessionId,
      ).fetch("https://managed-session.internal/v1/git-authorization", {
        method: "POST",
        headers: { authorization: request.headers.get("authorization") ?? "" },
      });
      if (!authorization.ok)
        return json({ error: "Git authorization unavailable" }, 403);
      const scope: unknown = await authorization.json();
      const scopeFields =
        typeof scope === "object" && scope !== null
          ? Object.fromEntries(Object.entries(scope))
          : null;
      if (
        typeof scopeFields?.subject !== "string" ||
        typeof scopeFields.capabilityHandle !== "string"
      ) {
        return json({ error: "Git authorization unavailable" }, 403);
      }
      const owner = gitProxyMatch[2] ?? "";
      const repository = gitProxyMatch[3] ?? "";
      const suffix = gitProxyMatch[4] ?? "";
      if (
        !matchesGitRepositoryScope(
          owner,
          repository,
          scopeFields.repositorySlug,
        )
      ) {
        return json({ error: "Git repository scope denied" }, 403);
      }
      return proxyProviderRequest(
        {
          provider: "github",
          gitSmartHttp: true,
          subject: scopeFields.subject,
          capabilityHandle: scopeFields.capabilityHandle,
          upstreamUrl: `https://github.com/${owner}/${repository}${suffix}${url.search}`,
          method: request.method,
          body: request.body,
          contentType: request.headers.get("content-type"),
          accept: request.headers.get("accept"),
          contentLength: Number(request.headers.get("content-length") ?? 0),
        },
        {
          resolve: (subject, handle) =>
            resolveProviderCredential(env, subject, handle, "github"),
          fetch,
          maxEgressBytes: Number(env.MANAGED_RUNTIME_MAX_EGRESS_BYTES),
        },
      );
    }
    const authMatch = url.pathname.match(/^\/v1\/internal\/auth\/([^/]+)$/u);
    if (authMatch !== null && request.method === "POST") {
      if (!hasServiceAuthorization(request, env)) {
        return json({ error: "Unauthorized" }, 401);
      }
      const subject = decodeURIComponent(authMatch[1] ?? "");
      const body: unknown = await request.json();
      return env.MANAGED_ACCOUNT.getByName(subject).fetch(
        INTERNAL_ROUTES.managedAccount.authState,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            ...(typeof body === "object" && body !== null ? body : {}),
            subject,
          }),
        },
      );
    }
    const capabilityMatch = url.pathname.match(
      /^\/v1\/account-capabilities\/([^/]+)$/u,
    );
    if (capabilityMatch !== null && request.method === "GET") {
      if (!hasBearerServiceAuthorization(request, env)) {
        return json({ error: "Unauthorized" }, 401);
      }
      const subject = decodeURIComponent(capabilityMatch[1] ?? "");
      return env.MANAGED_ACCOUNT.getByName(subject).fetch(
        INTERNAL_ROUTES.managedAccount.capabilities,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ subject }),
        },
      );
    }
    const sessionMatch = url.pathname.match(
      /^\/v1\/sessions\/([^/]+)\/(commands|events|cancel)$/u,
    );
    if (sessionMatch !== null) {
      const sessionId = decodeURIComponent(sessionMatch[1] ?? "");
      const operation = sessionMatch[2] ?? "";
      const target = new URL(
        `https://managed-session.internal/v1/${operation}`,
      );
      target.search = url.search;
      const forwardedRequest = new Request(target, request);
      const response =
        await env.MANAGED_SESSION.getByName(sessionId).fetch(forwardedRequest);
      return response;
    }
    return json({ error: "Not found" }, 404);
  },
} satisfies ExportedHandler<ManagedRuntimeEnv>;
