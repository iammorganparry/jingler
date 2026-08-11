import { getSandbox } from "@cloudflare/sandbox"
import type { ManagedRuntimeAction } from "@jingler/core"
import { WorkspaceProvisioningPlan } from "@jingler/core"
import { Either, Schema } from "effect"
import { decodeManagedGrantRequest } from "./grant-request.js"
import { matchesGitRepositoryScope } from "./git-scope.js"
import { issueManagedRuntimeGrant } from "./grant.js"
import { hydrateWorkspace } from "./workspace-hydration.js"
import {
  createWorkspaceCheckpoint,
  restoreWorkspaceCheckpoint
} from "./workspace-checkpoint.js"
import {
  createControlPlaneProviderFetch,
  providerAuthorizationScope,
  proxyProviderRequest,
  resolveProviderCredential
} from "./provider-proxy.js"
import type { ManagedRuntimeEnv } from "./runtime-env.js"
import { r2CheckpointStore } from "./r2-checkpoint-store.js"
import { json } from "./worker-http.js"
import {
  destroyRuntimeSession,
  unregisterRuntimeSession
} from "./runtime-cleanup.js"

export { Sandbox } from "@cloudflare/sandbox"
export { ManagedAccountObject } from "./account-runtime.js"
export { ManagedSessionObject } from "./session-runtime.js"

const hasServiceAuthorization = (
  request: Request,
  env: ManagedRuntimeEnv
): boolean =>
  env.MANAGED_RUNTIME_SERVICE_SECRET.length >= 32 &&
  request.headers.get("x-jingler-service-secret") ===
    env.MANAGED_RUNTIME_SERVICE_SECRET

const hasBearerServiceAuthorization = (
  request: Request,
  env: ManagedRuntimeEnv
): boolean =>
  env.MANAGED_RUNTIME_SERVICE_SECRET.length >= 32 &&
  request.headers.get("authorization") ===
    `Bearer ${env.MANAGED_RUNTIME_SERVICE_SECRET}`

const grantRequestIdentity = (value: unknown): {
  readonly subject: string
  readonly environmentId: string
} | null => {
  if (typeof value !== "object" || value === null) return null
  const fields = Object.fromEntries(Object.entries(value))
  return typeof fields.subject === "string" &&
    typeof fields.environmentId === "string"
    ? { subject: fields.subject, environmentId: fields.environmentId }
    : null
}

const runtimeSessionIdentity = (value: unknown): {
  readonly subject: string
  readonly environmentId: string
  readonly sessionId: string
} | null => {
  if (typeof value !== "object" || value === null) return null
  const fields = Object.fromEntries(Object.entries(value))
  return typeof fields.subject === "string" &&
    typeof fields.environmentId === "string" &&
    typeof fields.sessionId === "string"
    ? {
        subject: fields.subject,
        environmentId: fields.environmentId,
        sessionId: fields.sessionId
      }
    : null
}

interface RuntimeRegistration {
  readonly authStateVersion: number
  readonly sessionGeneration: number
  readonly credentialHandles: {
    readonly codex: string | null
    readonly claude: string | null
    readonly github: string | null
  }
}

class RuntimeRegistrationError extends Error {
  readonly status: number

  constructor(status: number, message: string) {
    super(message)
    this.name = "RuntimeRegistrationError"
    this.status = status
  }
}

const runtimeRegistration = async (
  env: ManagedRuntimeEnv,
  input: {
    readonly subject: string
    readonly environmentId: string
    readonly environmentGeneration: number
    readonly sessionId: string
    readonly reservationId: string | null
    readonly repositorySlug?: string
  }
): Promise<RuntimeRegistration> => {
  const accountResponse = await env.MANAGED_ACCOUNT.getByName(input.subject).fetch(
    "https://managed-account.internal/v1/sessions/register",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ subject: input.subject, sessionId: input.sessionId })
    }
  )
  if (!accountResponse.ok) {
    throw new RuntimeRegistrationError(
      accountResponse.status,
      accountResponse.status === 429
        ? "Managed session concurrency exceeded"
        : "Managed execution is not authorized"
    )
  }
  const releaseRegistration = () =>
    unregisterRuntimeSession(env, input.subject, input.sessionId).catch(
      () => undefined
    )
  let accountBody: unknown
  try {
    accountBody = await accountResponse.json()
  } catch {
    await releaseRegistration()
    throw new RuntimeRegistrationError(502, "Managed account registration was invalid")
  }
  const account =
    typeof accountBody === "object" && accountBody !== null
      ? Object.fromEntries(Object.entries(accountBody))
      : null
  const auth =
    typeof account?.auth === "object" && account.auth !== null
      ? Object.fromEntries(Object.entries(account.auth))
      : null
  const handles =
    typeof account?.credentialHandles === "object" &&
    account.credentialHandles !== null
      ? Object.fromEntries(Object.entries(account.credentialHandles))
      : null
  if (auth?.admitted !== true || typeof auth.authStateVersion !== "number") {
    await releaseRegistration()
    throw new RuntimeRegistrationError(403, "Managed execution is not authorized")
  }
  const credentialHandles = {
    codex: typeof handles?.codex === "string" ? handles.codex : null,
    claude: typeof handles?.claude === "string" ? handles.claude : null,
    github: typeof handles?.github === "string" ? handles.github : null
  }
  const sessionResponse = await env.MANAGED_SESSION.getByName(input.sessionId).fetch(
    "https://managed-session.internal/v1/configure",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ...input,
        authStateVersion: auth.authStateVersion,
        codexCapabilityHandle: credentialHandles.codex,
        claudeCapabilityHandle: credentialHandles.claude,
        githubCapabilityHandle: credentialHandles.github
      })
    }
  )
  if (!sessionResponse.ok) {
    await releaseRegistration()
    throw new RuntimeRegistrationError(
      sessionResponse.status >= 400 && sessionResponse.status < 600
        ? sessionResponse.status
        : 503,
      "Managed session registration failed"
    )
  }
  const sessionBody: unknown = await sessionResponse.json()
  const session =
    typeof sessionBody === "object" && sessionBody !== null
      ? Object.fromEntries(Object.entries(sessionBody))
      : null
  if (typeof session?.sessionGeneration !== "number") {
    await releaseRegistration()
    throw new RuntimeRegistrationError(502, "Managed session registration was invalid")
  }
  return {
    authStateVersion: auth.authStateVersion,
    sessionGeneration: session.sessionGeneration,
    credentialHandles
  }
}

export default {
  async fetch(request: Request, env: ManagedRuntimeEnv): Promise<Response> {
    const url = new URL(request.url)
    if (url.pathname === "/health") {
      return json({
        status: "ok",
        service: "@jingler/managed-runtime",
        serviceAuthorizationConfigured:
          typeof env.MANAGED_RUNTIME_SERVICE_SECRET === "string" &&
          env.MANAGED_RUNTIME_SERVICE_SECRET.length >= 32
      })
    }
    if (url.pathname === "/v1/grants" && request.method === "POST") {
      if (!hasBearerServiceAuthorization(request, env)) {
        return json({ error: "Unauthorized" }, 401)
      }
      const input = decodeManagedGrantRequest(await request.json())
      if (input === null) return json({ error: "Invalid grant request" }, 400)
      let registration: RuntimeRegistration
      try {
        registration = await runtimeRegistration(env, input)
      } catch (cause) {
        return cause instanceof RuntimeRegistrationError
          ? json({ error: cause.message }, cause.status)
          : json({ error: "Managed execution registration failed" }, 503)
      }
      if (
        registration.credentialHandles.codex === null &&
        registration.credentialHandles.claude === null
      ) {
        await destroyRuntimeSession(env, input).catch(() => undefined)
        return json({ error: "Managed execution is not authorized" }, 403)
      }
      const issued = await issueManagedRuntimeGrant(
        {
          ...input,
          authStateVersion: registration.authStateVersion,
          sessionGeneration: registration.sessionGeneration
        },
        env.MANAGED_RUNTIME_GRANT_SECRET
      )
      return json({
        version: 1,
        runtimeUrl: env.MANAGED_RUNTIME_ORIGIN,
        grant: issued.grant,
        expiresAt: issued.claims.expiresAt
      })
    }
    if (url.pathname === "/v1/sandbox-probe" && request.method === "POST") {
      if (!hasServiceAuthorization(request, env)) {
        return json({ error: "Unauthorized" }, 401)
      }
      const sandbox = getSandbox(env.Sandbox, "probe", {
        transport: "rpc",
        normalizeId: true,
        enableDefaultSession: false,
        sleepAfter: "2m"
      })
      const result = await sandbox.exec("printf ready", { cwd: "/workspace" })
      await sandbox.destroy()
      return json({ success: result.success, output: result.stdout })
    }
    if (url.pathname === "/v1/checkpoint-probe" && request.method === "POST") {
      if (!hasServiceAuthorization(request, env)) {
        return json({ error: "Unauthorized" }, 401)
      }
      const suffix = crypto.randomUUID().replaceAll("-", "")
      const sessionId = `checkpoint_probe_${suffix}`
      const checkpointId = `checkpoint_${suffix}`
      const store = r2CheckpointStore(env.WORKSPACE_CHECKPOINTS)
      let sandbox = getSandbox(env.Sandbox, sessionId, {
        transport: "rpc",
        normalizeId: true,
        enableDefaultSession: false,
        sleepAfter: "2m"
      })
      let archiveKey: string | null = null
      const manifestKey = `manifests/checkpoint-probe/${encodeURIComponent(sessionId)}/${encodeURIComponent(checkpointId)}.json`
      try {
        const initialized = await sandbox.exec(
          "git init --initial-branch=main . && git config user.email probe@jingler.dev && git config user.name Jingler && printf checkpoint-ready > checkpoint.txt && git add checkpoint.txt && git commit -m base && printf dirty-state > dirty.txt",
          { cwd: "/workspace", timeout: 30_000 }
        )
        if (!initialized.success) throw new Error("Checkpoint probe setup failed")
        const created = await createWorkspaceCheckpoint(sandbox, store, {
          checkpointId,
          subject: "checkpoint-probe",
          environmentId: "managed-probe",
          sessionId,
          previousCheckpoint: null,
          eventCursor: 1,
          nowSeconds: Math.floor(Date.now() / 1_000),
          retentionSeconds: 300,
          maxBytes: 1_048_576
        })
        archiveKey = created.manifest.backup.key
        await sandbox.destroy()
        sandbox = getSandbox(env.Sandbox, sessionId, {
          transport: "rpc",
          normalizeId: true,
          enableDefaultSession: false,
          sleepAfter: "2m"
        })
        await restoreWorkspaceCheckpoint(sandbox, store, created.manifest)
        const verified = await sandbox.exec(
          "test \"$(cat checkpoint.txt)\" = checkpoint-ready && test \"$(cat dirty.txt)\" = dirty-state && printf restored",
          { cwd: "/workspace", timeout: 30_000 }
        )
        return json({
          success: verified.success,
          output: verified.stdout,
          checkpointId
        }, verified.success ? 200 : 500)
      } catch (cause) {
        return json({
          success: false,
          error: cause instanceof Error ? cause.message : "Checkpoint probe failed"
        }, 500)
      } finally {
        await sandbox.destroy().catch(() => undefined)
        await env.WORKSPACE_CHECKPOINTS.delete(manifestKey).catch(() => undefined)
        if (archiveKey !== null) {
          await env.WORKSPACE_CHECKPOINTS.delete(archiveKey).catch(() => undefined)
        }
      }
    }
    if (url.pathname === "/v1/environments/destroy" && request.method === "POST") {
      if (!hasBearerServiceAuthorization(request, env)) {
        return json({ error: "Unauthorized" }, 401)
      }
      const body = grantRequestIdentity(await request.json())
      if (body === null) return json({ error: "Invalid environment cleanup request" }, 400)
      const account = env.MANAGED_ACCOUNT.getByName(body.subject)
      const listed = await account.fetch(
        "https://managed-account.internal/v1/sessions/list",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ subject: body.subject })
        }
      )
      if (!listed.ok) return json({ error: "Managed session inventory unavailable" }, 503)
      const listedBody = await listed.json() as { sessionIds?: unknown }
      const sessionIds = Array.isArray(listedBody.sessionIds)
        ? listedBody.sessionIds.filter((value): value is string => typeof value === "string")
        : []
      const results = await Promise.all(sessionIds.map((sessionId) =>
        env.MANAGED_SESSION.getByName(sessionId).fetch(
          "https://managed-session.internal/v1/destroy",
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body)
          }
        )
      ))
      if (results.some((response) => !response.ok && response.status !== 403)) {
        return json({ error: "Managed environment cleanup incomplete" }, 503)
      }
      return json({ destroyed: results.filter((response) => response.ok).length })
    }
    if (url.pathname === "/v1/sessions/destroy" && request.method === "POST") {
      if (!hasBearerServiceAuthorization(request, env)) {
        return json({ error: "Unauthorized" }, 401)
      }
      const body = runtimeSessionIdentity(await request.json())
      if (body === null) return json({ error: "Invalid session cleanup request" }, 400)
      await destroyRuntimeSession(env, body)
      return json({ destroyed: true })
    }
    if (url.pathname === "/v1/workspaces/hydrate" && request.method === "POST") {
      if (!hasBearerServiceAuthorization(request, env)) {
        return json({ error: "Unauthorized" }, 401)
      }
      const body: unknown = await request.json()
      const bodyFields =
        typeof body === "object" && body !== null
          ? Object.fromEntries(Object.entries(body))
          : null
      const decoded = Schema.decodeUnknownEither(WorkspaceProvisioningPlan)(
        bodyFields?.plan,
        { onExcessProperty: "error" }
      )
      if (
        Either.isLeft(decoded) ||
        typeof bodyFields?.subject !== "string" ||
        typeof bodyFields.environmentId !== "string" ||
        typeof bodyFields.environmentGeneration !== "number" ||
        typeof bodyFields?.sessionId !== "string" ||
        typeof bodyFields.repositoryUrl !== "string"
      ) {
        return json({ error: "Invalid workspace hydration request" }, 400)
      }
      const sandbox = getSandbox(env.Sandbox, bodyFields.sessionId, {
        transport: "rpc",
        normalizeId: true,
        enableDefaultSession: false,
        // Hydration can legitimately outlive the settled-session idle window:
        // a cold VM plus an exact-SHA Git fetch must remain active until the
        // workspace is ready. Subsequent session commands reapply the short
        // idle policy, and every failure path below destroys the sandbox.
        sleepAfter: `${env.MANAGED_RUNTIME_MAX_ACTIVE_SECONDS}s`
      })
      let registration: RuntimeRegistration
      try {
        registration = await runtimeRegistration(env, {
          subject: bodyFields.subject,
          environmentId: bodyFields.environmentId,
          environmentGeneration: bodyFields.environmentGeneration,
          sessionId: bodyFields.sessionId,
          reservationId: null,
          repositorySlug: decoded.right.repository.slug
        })
      } catch (cause) {
        return cause instanceof RuntimeRegistrationError
          ? json({ error: cause.message }, cause.status)
          : json({ error: "Managed workspace registration failed" }, 503)
      }
      const cleanup = () => destroyRuntimeSession(env, {
        subject: bodyFields.subject,
        environmentId: bodyFields.environmentId,
        sessionId: bodyFields.sessionId
      })
      if (registration.credentialHandles.github === null) {
        await cleanup().catch(() => undefined)
        return json({ error: "GitHub authorization unavailable" }, 403)
      }
      const sessionStub = env.MANAGED_SESSION.getByName(bodyFields.sessionId)
      const tokenResponse = await sessionStub.fetch(
        "https://managed-session.internal/v1/git-token",
        { method: "POST" }
      )
      if (!tokenResponse.ok) {
        await cleanup().catch(() => undefined)
        return json({ error: "GitHub authorization unavailable" }, 403)
      }
      let tokenBody: unknown
      try {
        tokenBody = await tokenResponse.json()
      } catch {
        await cleanup().catch(() => undefined)
        return json({ error: "GitHub authorization unavailable" }, 403)
      }
      const tokenFields =
        typeof tokenBody === "object" && tokenBody !== null
          ? Object.fromEntries(Object.entries(tokenBody))
          : null
      if (typeof tokenFields?.token !== "string") {
        await cleanup().catch(() => undefined)
        return json({ error: "GitHub authorization unavailable" }, 403)
      }
      try {
        const repositorySlug = decoded.right.repository.slug
        const identity = await hydrateWorkspace(
          sandbox,
          decoded.right,
          `${env.MANAGED_RUNTIME_ORIGIN}/v1/git/${encodeURIComponent(bodyFields.sessionId)}/${repositorySlug}.git`,
          {
            authorizationHeader: `Bearer ${tokenFields.token}`,
            canonicalRepositoryUrl: bodyFields.repositoryUrl
          }
        )
        return json({ version: 1, identity })
      } catch (cause) {
        await cleanup().catch(async () => {
          await sandbox.destroy().catch(() => undefined)
          await unregisterRuntimeSession(env, bodyFields.subject, bodyFields.sessionId).catch(
            () => undefined
          )
        })
        return json(
          {
            error: cause instanceof Error ? cause.message : "Workspace hydration failed"
          },
          409
        )
      } finally {
        await sessionStub.fetch(
          "https://managed-session.internal/v1/git-token/revoke",
          { method: "POST" }
        )
      }
    }
    const providerProxyMatch = url.pathname.match(
      /^\/v1\/provider\/(codex|claude)\/([^/]+)(\/.*)$/u
    )
    if (providerProxyMatch !== null) {
      const provider = providerProxyMatch[1] as "codex" | "claude"
      const sessionId = decodeURIComponent(providerProxyMatch[2] ?? "")
      const authorization = await env.MANAGED_SESSION.getByName(sessionId).fetch(
        `https://managed-session.internal/v1/provider-authorization/${provider}`,
        { method: "POST", headers: { authorization: request.headers.get("authorization") ?? "" } }
      )
      if (!authorization.ok) {
        console.warn(JSON.stringify({
          component: "managed-provider-proxy",
          event: "session_scope_denied",
          provider,
          status: authorization.status
        }))
        return json({ error: "Provider authorization unavailable" }, 403)
      }
      const scope = providerAuthorizationScope(await authorization.json())
      if (scope === null) {
        return json({ error: "Provider authorization unavailable" }, 403)
      }
      return proxyProviderRequest(
        {
          provider,
          subject: scope.subject,
          capabilityHandle: scope.capabilityHandle,
          upstreamUrl: provider === "codex"
            ? `https://api.openai.com${providerProxyMatch[3] ?? "/"}`
            : `https://api.anthropic.com${providerProxyMatch[3] ?? "/"}`,
          method: request.method === "GET" ? "GET" : "POST",
          body: request.body,
          contentType: request.headers.get("content-type"),
          accept: request.headers.get("accept"),
          userAgent: request.headers.get("user-agent"),
          originator: request.headers.get("originator"),
          openAiBeta: request.headers.get("openai-beta"),
          anthropicBeta: request.headers.get("anthropic-beta"),
          contentLength: Number(request.headers.get("content-length") ?? 0)
        },
        {
          resolve: (subject, handle) =>
            resolveProviderCredential(env, subject, handle, provider),
          fetch: createControlPlaneProviderFetch({
            controlPlaneUrl: env.MANAGED_CONTROL_PLANE_URL,
            serviceSecret: env.MANAGED_RUNTIME_SERVICE_SECRET,
            fetch
          }),
          maxEgressBytes: Number(env.MANAGED_RUNTIME_MAX_EGRESS_BYTES)
        }
      )
    }
    const gitProxyMatch = url.pathname.match(
      /^\/v1\/git\/([^/]+)\/([^/]+)\/([^/]+\.git)(\/.*)?$/u
    )
    if (gitProxyMatch !== null && (request.method === "GET" || request.method === "POST")) {
      const sessionId = decodeURIComponent(gitProxyMatch[1] ?? "")
      const authorization = await env.MANAGED_SESSION.getByName(sessionId).fetch(
        "https://managed-session.internal/v1/git-authorization",
        { method: "POST", headers: { authorization: request.headers.get("authorization") ?? "" } }
      )
      if (!authorization.ok) return json({ error: "Git authorization unavailable" }, 403)
      const scope: unknown = await authorization.json()
      const scopeFields =
        typeof scope === "object" && scope !== null
          ? Object.fromEntries(Object.entries(scope))
          : null
      if (
        typeof scopeFields?.subject !== "string" ||
        typeof scopeFields.capabilityHandle !== "string"
      ) {
        return json({ error: "Git authorization unavailable" }, 403)
      }
      const owner = gitProxyMatch[2] ?? ""
      const repository = gitProxyMatch[3] ?? ""
      const suffix = gitProxyMatch[4] ?? ""
      if (!matchesGitRepositoryScope(owner, repository, scopeFields.repositorySlug)) {
        return json({ error: "Git repository scope denied" }, 403)
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
          contentLength: Number(request.headers.get("content-length") ?? 0)
        },
        {
          resolve: (subject, handle) =>
            resolveProviderCredential(env, subject, handle, "github"),
          fetch,
          maxEgressBytes: Number(env.MANAGED_RUNTIME_MAX_EGRESS_BYTES)
        }
      )
    }
    const authMatch = url.pathname.match(/^\/v1\/internal\/auth\/([^/]+)$/u)
    if (authMatch !== null && request.method === "POST") {
      if (!hasServiceAuthorization(request, env)) {
        return json({ error: "Unauthorized" }, 401)
      }
      const subject = decodeURIComponent(authMatch[1] ?? "")
      const body: unknown = await request.json()
      return env.MANAGED_ACCOUNT.getByName(subject).fetch(
        "https://managed-account.internal/v1/auth-state",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            ...(typeof body === "object" && body !== null ? body : {}),
            subject
          })
        }
      )
    }
    const capabilityMatch = url.pathname.match(/^\/v1\/account-capabilities\/([^/]+)$/u)
    if (capabilityMatch !== null && request.method === "GET") {
      if (!hasBearerServiceAuthorization(request, env)) {
        return json({ error: "Unauthorized" }, 401)
      }
      const subject = decodeURIComponent(capabilityMatch[1] ?? "")
      return env.MANAGED_ACCOUNT.getByName(subject).fetch(
        "https://managed-account.internal/v1/capabilities",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ subject })
        }
      )
    }
    const sessionMatch = url.pathname.match(/^\/v1\/sessions\/([^/]+)\/(commands|events|cancel)$/u)
    if (sessionMatch !== null) {
      const sessionId = decodeURIComponent(sessionMatch[1] ?? "")
      const operation = sessionMatch[2] ?? ""
      const target = new URL(`https://managed-session.internal/v1/${operation}`)
      target.search = url.search
      const forwardedRequest = new Request(target, request)
      const response = await env.MANAGED_SESSION.getByName(sessionId).fetch(
        forwardedRequest
      )
      return response
    }
    return json({ error: "Not found" }, 404)
  }
} satisfies ExportedHandler<ManagedRuntimeEnv>
