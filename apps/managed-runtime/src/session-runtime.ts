import {
  managedRuntimeActionForOperation,
  type ManagedRuntimeAction,
  type RemoteSessionCommand,
  type RemoteSessionEvent
} from "@jingler/core"
import { RemoteSessionCommand as RemoteSessionCommandSchema } from "@jingler/core"
import { getSandbox, parseSSEStream, type LogEvent } from "@cloudflare/sandbox"
import { DurableObject } from "cloudflare:workers"
import { Either, Schema } from "effect"
import { decodeManagedAuthSnapshot } from "./auth-subscription.js"
import {
  bearerManagedGrant,
  verifyManagedRuntimeGrant,
  type ManagedGrantVerification
} from "./grant.js"
import { applyManagedAuthorizationSnapshot } from "./authorization.js"
import { managedCodexConfig, managedCodexHome } from "./harness-config.js"
import {
  emptyManagedSessionJournal,
  ManagedSessionJournal,
  type ManagedSessionJournalState
} from "./session-journal.js"
import type { ManagedRuntimeEnv } from "./runtime-env.js"
import { redactedUsageTelemetry, shouldSampleUsage } from "./usage-policy.js"
import {
  createWorkspaceCheckpoint,
  type WorkspaceCheckpointManifest
} from "./workspace-checkpoint.js"
import { r2CheckpointStore } from "./r2-checkpoint-store.js"
import { fields, json } from "./worker-http.js"

interface RuntimeMetadata {
  readonly subject: string
  readonly environmentId: string
  readonly sessionId: string
  readonly environmentGeneration: number
  readonly sessionGeneration: number
  readonly authStateVersion: number
  readonly processId: string | null
  readonly authorized: boolean
  readonly harness: "codex" | "claude" | null
  readonly codexCapabilityHandle: string | null
  readonly claudeCapabilityHandle: string | null
  readonly githubCapabilityHandle: string | null
  readonly repositorySlug: string | null
  readonly providerTokenHash: string | null
  readonly gitTokenHash: string | null
  readonly usageReservationId: string | null
  readonly usageStartedAt: number | null
  readonly checkpoint: WorkspaceCheckpointManifest | null
}

const METADATA_KEY = "runtime-metadata"
const JOURNAL_KEY = "session-journal"

const shellQuote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`

const sha256 = async (value: string): Promise<string> => {
  const bytes = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))
  )
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("")
}

const harnessFromCommand = (
  command: RemoteSessionCommand,
  current: RuntimeMetadata["harness"]
): RuntimeMetadata["harness"] => {
  const payload = fields(command.payload)
  const direct = payload?.cli
  const source = fields(payload?.sourceSession)?.cli
  const candidate = direct ?? source
  return candidate === "codex" || candidate === "claude" ? candidate : current
}

export const decodeManagedCommandFrame = (
  value: unknown
):
  | { readonly type: "managed-event"; readonly event: { readonly kind: "event"; readonly payload: unknown } }
  | { readonly type: "managed-complete" | "managed-failed"; readonly payload: unknown }
  | null => {
  const frame = fields(value)
  if (frame?.type === "managed-event") {
    const event = fields(frame.event)
    return event?.kind === "event"
      ? { type: "managed-event", event: { kind: "event", payload: event.payload } }
      : null
  }
  return frame?.type === "managed-complete" || frame?.type === "managed-failed"
    ? { type: frame.type, payload: frame.payload }
    : null
}

export class ManagedSessionObject extends DurableObject<ManagedRuntimeEnv> {
  #journalTail: Promise<void> = Promise.resolve()
  #executionTail: Promise<void> = Promise.resolve()

  async #metadata(): Promise<RuntimeMetadata | null> {
    return (await this.ctx.storage.get<RuntimeMetadata>(METADATA_KEY)) ?? null
  }

  async #journal(): Promise<ManagedSessionJournal> {
    const restored =
      (await this.ctx.storage.get<ManagedSessionJournalState>(JOURNAL_KEY)) ??
      emptyManagedSessionJournal()
    return new ManagedSessionJournal(restored)
  }

  async #persistJournal(journal: ManagedSessionJournal): Promise<void> {
    await this.ctx.storage.put(JOURNAL_KEY, journal.snapshot())
  }

  #mutateJournal<Value>(
    mutation: (journal: ManagedSessionJournal) => Value
  ): Promise<Value> {
    const result = this.#journalTail.then(async () => {
      const journal = await this.#journal()
      const value = mutation(journal)
      await this.#persistJournal(journal)
      return value
    })
    this.#journalTail = result.then(
      () => undefined,
      () => undefined
    )
    return result
  }

  #scheduleExecution(command: RemoteSessionCommand): Promise<void> {
    // A Sandbox has one mutable transport configuration. Opening transcript,
    // file and diff reads concurrently used to let one command switch back to
    // RPC while another was still consuming its HTTP log stream. Serialize the
    // short-lived command runners per managed session; cancellation uses the
    // dedicated /cancel endpoint and therefore never waits behind this queue.
    const execution = this.#executionTail.then(() => this.#execute(command))
    this.#executionTail = execution.catch(() => undefined)
    return execution
  }

  async #authorize(
    request: Request,
    metadata: RuntimeMetadata,
    action: ManagedRuntimeAction
  ): Promise<ManagedGrantVerification> {
    if (!metadata.authorized) {
      return { ok: false, reason: "wrong-auth-version" }
    }
    return verifyManagedRuntimeGrant(
      bearerManagedGrant(request),
      this.env.MANAGED_RUNTIME_GRANT_SECRET,
      {
        action,
        authStateVersion: metadata.authStateVersion,
        environmentGeneration: metadata.environmentGeneration,
        sessionGeneration: metadata.sessionGeneration,
        subject: metadata.subject,
        environmentId: metadata.environmentId,
        sessionId: metadata.sessionId
      }
    )
  }

  async #append(
    commandId: string,
    event: Omit<RemoteSessionEvent, "version" | "commandId" | "sessionId" | "eventSequence">
  ): Promise<void> {
    const value = await this.#mutateJournal((journal) =>
      journal.append(commandId, event)
    )
    this.#broadcast(commandId, value)
  }

  #broadcast(commandId: string, event: RemoteSessionEvent): void {
    for (const socket of this.ctx.getWebSockets(commandId)) {
      try {
        socket.send(JSON.stringify(event))
      } catch {
        socket.close(1011, "delivery-failed")
      }
    }
  }

  async #settle(
    commandId: string,
    status: "complete" | "failed" | "cancelled",
    payload: unknown,
    checkpoint: boolean
  ): Promise<void> {
    const terminal = await this.#settleJournal(commandId, status, payload)
    this.#broadcast(commandId, terminal)
    if (checkpoint) await this.#checkpoint(terminal.eventSequence)
    const metadata = await this.#metadata()
    if (metadata !== null) {
      await this.ctx.storage.put(METADATA_KEY, {
        ...metadata,
        processId: null,
        providerTokenHash: null
      })
      await this.#settleUsage()
      await this.#unregisterSession(metadata)
    }
  }

  #settleJournal(
    commandId: string,
    status: "complete" | "failed" | "cancelled",
    payload: unknown
  ): Promise<RemoteSessionEvent> {
    return this.#mutateJournal((journal) =>
      journal.settle(commandId, status, payload)
    )
  }

  async #checkpoint(eventCursor: number): Promise<void> {
    const metadata = await this.#metadata()
    if (metadata === null) return
    const sandbox = getSandbox(this.env.Sandbox, metadata.sessionId, {
      transport: "rpc",
      normalizeId: true,
      enableDefaultSession: false,
      sleepAfter: `${this.env.MANAGED_RUNTIME_IDLE_SECONDS}s`
    })
    try {
      const result = await createWorkspaceCheckpoint(
        sandbox,
        r2CheckpointStore(this.env.WORKSPACE_CHECKPOINTS),
        {
          checkpointId: `checkpoint_${crypto.randomUUID().replaceAll("-", "")}`,
          subject: metadata.subject,
          environmentId: metadata.environmentId,
          sessionId: metadata.sessionId,
          previousCheckpoint: metadata.checkpoint,
          eventCursor,
          nowSeconds: Math.floor(Date.now() / 1_000),
          retentionSeconds: Number(this.env.MANAGED_RUNTIME_CHECKPOINT_RETENTION_SECONDS),
          maxBytes: Number(this.env.MANAGED_RUNTIME_MAX_CHECKPOINT_BYTES)
        }
      )
      await this.ctx.storage.put(METADATA_KEY, {
        ...metadata,
        checkpoint: result.manifest
      })
    } catch {
      // The turn is already durable in the event journal. A later settled turn
      // retries the content-aware checkpoint without delaying client delivery.
    }
  }

  async #settleUsage(): Promise<void> {
    const metadata = await this.#metadata()
    if (metadata === null || metadata.usageReservationId === null) return
    const activeSeconds = Math.min(
      Number(this.env.MANAGED_RUNTIME_MAX_ACTIVE_SECONDS),
      Math.max(0, Math.ceil((Date.now() - (metadata.usageStartedAt ?? Date.now())) / 1_000))
    )
    try {
      const response = await fetch(
        new URL("/api/internal/managed-usage/settle", this.env.MANAGED_CONTROL_PLANE_URL),
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-jingler-service-secret": this.env.MANAGED_RUNTIME_SERVICE_SECRET
          },
          body: JSON.stringify({
            userId: metadata.subject,
            reservationId: metadata.usageReservationId,
            activeSeconds
          })
        }
      )
      if (!response.ok) throw new Error(`usage settlement returned ${response.status}`)
      await this.ctx.storage.put(METADATA_KEY, {
        ...metadata,
        usageReservationId: null,
        usageStartedAt: null
      })
      if (shouldSampleUsage(metadata.usageReservationId)) {
        console.log(JSON.stringify(redactedUsageTelemetry({
          activeSeconds,
          cleanup: "completed"
        })))
      }
    } catch {
      await this.ctx.storage.setAlarm(Date.now() + 60_000)
    }
  }

  async #unregisterSession(metadata: RuntimeMetadata): Promise<void> {
    await this.env.MANAGED_ACCOUNT.getByName(metadata.subject).fetch(
      "https://managed-account.internal/v1/sessions/unregister",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          subject: metadata.subject,
          sessionId: metadata.sessionId
        })
      }
    ).catch(() => undefined)
  }

  override async alarm(): Promise<void> {
    await this.#settleUsage()
  }

  async #execute(command: RemoteSessionCommand): Promise<void> {
    const sandbox = getSandbox(this.env.Sandbox, command.sessionId, {
      transport: "rpc",
      normalizeId: true,
      enableDefaultSession: false,
      sleepAfter: `${this.env.MANAGED_RUNTIME_IDLE_SECONDS}s`
    })
    const inputDirectory = "/tmp/jingler-commands"
    const inputFile = `${inputDirectory}/${await sha256(command.commandId)}.json`
    let phase = "preparing command input"
    const checkpoint = managedRuntimeActionForOperation(command.operation) !== "session.observe"
    try {
      await sandbox.mkdir(inputDirectory, { recursive: true })
      await sandbox.writeFile(inputFile, JSON.stringify(command))
      const metadata = await this.#metadata()
      if (metadata === null) throw new Error("Managed runtime metadata disappeared")
      const harness = harnessFromCommand(command, metadata.harness)
      if (harness === null) throw new Error("Managed session harness is unavailable")
      if (
        (harness === "codex" && metadata.codexCapabilityHandle === null) ||
        (harness === "claude" && metadata.claudeCapabilityHandle === null)
      ) {
        throw new Error(`Managed ${harness} authorization is unavailable`)
      }
      const providerToken = `provider_${crypto.randomUUID().replaceAll("-", "")}`
      const codexBaseUrl = `${this.env.MANAGED_RUNTIME_ORIGIN}/v1/provider/codex/${encodeURIComponent(command.sessionId)}/v1`
      if (harness === "codex") {
        await sandbox.mkdir(managedCodexHome, { recursive: true })
        await sandbox.writeFile(
          `${managedCodexHome}/config.toml`,
          managedCodexConfig(codexBaseUrl)
        )
      }
      await this.ctx.storage.put(METADATA_KEY, {
        ...metadata,
        harness,
        processId: command.commandId,
        providerTokenHash: await sha256(providerToken),
        usageStartedAt: metadata.usageStartedAt ?? Date.now()
      })
      const commandLine = [
        "node",
        "/opt/jingler/jingler-device.mjs",
        "managed-command",
        "--root",
        "/workspace/.jingler-runtime",
        "--input",
        shellQuote(inputFile)
      ].join(" ")
      const processEnv = {
        ...(harness !== "codex"
          ? {}
          : {
              OPENAI_API_KEY: providerToken,
              OPENAI_BASE_URL: codexBaseUrl,
              CODEX_HOME: managedCodexHome
            }),
        ...(harness !== "claude"
          ? {}
          : {
              ANTHROPIC_AUTH_TOKEN: providerToken,
              ANTHROPIC_BASE_URL: `${this.env.MANAGED_RUNTIME_ORIGIN}/v1/provider/claude/${encodeURIComponent(command.sessionId)}`
            })
      }
      let settled = false
      let buffered = ""
      const admitOutput = async (chunk: string): Promise<void> => {
        buffered += chunk
        while (true) {
          const newline = buffered.indexOf("\n")
          if (newline < 0) return
          const line = buffered.slice(0, newline)
          buffered = buffered.slice(newline + 1)
          if (!line) continue
          let frame: ReturnType<typeof decodeManagedCommandFrame> = null
          try {
            frame = decodeManagedCommandFrame(JSON.parse(line))
          } catch {
            // The command runner emits protocol frames on stdout only. Ignore
            // non-protocol dependency noise rather than relaying secrets/logs.
          }
          if (frame?.type === "managed-event") {
            await this.#append(command.commandId, frame.event)
          } else if (frame?.type === "managed-complete") {
            await this.#settle(command.commandId, "complete", frame.payload, checkpoint)
            settled = true
          } else if (frame?.type === "managed-failed") {
            await this.#settle(command.commandId, "failed", frame.payload, checkpoint)
            settled = true
          }
        }
      }

      // Only a real agent turn needs incremental output. Conversation bootstrap,
      // file/diff reads and lifecycle mutations return one bounded protocol
      // result, so a single RPC exec is both cheaper and immune to the SDK's
      // long-lived ReadableStream transport edge cases.
      if (command.operation !== "Agent.run") {
        phase = "running the bounded command"
        const result = await sandbox.exec(commandLine, {
          cwd: "/workspace",
          env: processEnv,
          timeout: Number(this.env.MANAGED_RUNTIME_MAX_ACTIVE_SECONDS) * 1_000
        })
        await admitOutput(result.stdout.endsWith("\n") ? result.stdout : `${result.stdout}\n`)
        if (!settled) {
          await this.#settle(command.commandId, "failed", {
            code: "runtime-protocol-ended",
            message: `Managed command runner exited without a terminal frame (${result.exitCode}).`
          }, checkpoint)
        }
        return
      }

      phase = "creating the execution session"
      const session = await sandbox.createSession({
        id: "jingler-session",
        name: "Jingler managed session",
        cwd: "/workspace"
      })
      phase = "starting the harness process"
      const process = await session.startProcess(commandLine, {
        cwd: "/workspace",
        processId: command.commandId,
        autoCleanup: false,
        env: processEnv
      })
      // RPC is efficient for bounded lifecycle operations, but ReadableStream
      // values can be disconnected when they cross the Worker↔DO RPC boundary.
      // Use one HTTP/SSE request for the long-lived process log stream while
      // retaining RPC for every other sandbox operation.
      const streamSandbox = getSandbox(this.env.Sandbox, command.sessionId, {
        transport: "http",
        normalizeId: true,
        enableDefaultSession: false,
        sleepAfter: `${this.env.MANAGED_RUNTIME_IDLE_SECONDS}s`
      })
      // getSandbox applies transport configuration asynchronously. Await the
      // explicit switch so this stream cannot accidentally start over RPC.
      await streamSandbox.setTransport("http")
      try {
        phase = "opening the harness log stream"
        const processSignal = AbortSignal.timeout(
          Number(this.env.MANAGED_RUNTIME_MAX_ACTIVE_SECONDS) * 1_000
        )
        const stream = await streamSandbox.streamProcessLogs(process.id)
        let exitCode: number | null = null
        phase = "reading harness output"
        for await (const event of parseSSEStream<LogEvent>(stream, processSignal)) {
          if (event.type === "stdout") {
            await admitOutput(event.data ?? "")
            // Jingler's terminal frame is the authoritative end of the
            // command. Cloudflare's process-log SSE stream can remain open
            // after the process has emitted that frame, so waiting for the
            // transport-level exit event would pin the session and its
            // container until the active-duration timeout.
            if (settled) break
          } else if (event.type === "error") {
            throw new Error(event.data || "Harness log stream failed")
          } else if (event.type === "exit") {
            exitCode = event.exitCode ?? 1
            break
          }
        }
        if (buffered.trim().length > 0) await admitOutput("\n")
        if (!settled) {
          await this.#settle(command.commandId, "failed", {
            code: "runtime-protocol-ended",
            message: `Managed command runner exited without a terminal frame (${exitCode ?? "unknown"}).`
          }, checkpoint)
        }
      } finally {
        await streamSandbox.setTransport("rpc").catch(() => undefined)
      }
    } catch (cause) {
      await this.#settle(command.commandId, "failed", {
        code: "runtime-failed",
        message: cause instanceof Error
          ? `Managed runtime failed while ${phase}: ${cause.message}`
          : `Managed runtime failed while ${phase}`
      }, checkpoint).catch(() => undefined)
    } finally {
      await sandbox.deleteFile(inputFile).catch(() => undefined)
    }
  }

  async #stopActive(reason: string): Promise<void> {
    const metadata = await this.#metadata()
    if (metadata === null) return
    await this.#terminateProcess(metadata, reason)
    await this.ctx.storage.put(METADATA_KEY, {
      ...metadata,
      processId: null,
      providerTokenHash: null,
      sessionGeneration: metadata.sessionGeneration + 1
    })
    await this.#settleUsage()
    await this.#unregisterSession(metadata)
  }

  async #terminateProcess(
    metadata: RuntimeMetadata,
    reason: string
  ): Promise<void> {
    if (metadata.processId === null) return
    const sandbox = getSandbox(this.env.Sandbox, metadata.sessionId, {
      transport: "rpc",
      normalizeId: true,
      enableDefaultSession: false,
      sleepAfter: `${this.env.MANAGED_RUNTIME_IDLE_SECONDS}s`
    })
    await sandbox.killProcess(metadata.processId).catch(() => undefined)
    try {
      const terminal = await this.#settleJournal(metadata.processId, "cancelled", {
        reason
      })
      this.#broadcast(metadata.processId, terminal)
      await this.#checkpoint(terminal.eventSequence)
    } catch {
      // A concurrently completing process may already have durably settled.
    }
  }

  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url)
    if (url.pathname === "/v1/configure" && request.method === "POST") {
      const body = fields(await request.json())
      if (
        typeof body?.subject !== "string" ||
        typeof body.environmentId !== "string" ||
        typeof body.sessionId !== "string" ||
        typeof body.environmentGeneration !== "number" ||
        typeof body.authStateVersion !== "number"
      ) {
        return json({ error: "Invalid runtime configuration" }, 400)
      }
      const previous = await this.#metadata()
      if (
        previous !== null &&
        (previous.subject !== body.subject ||
          previous.environmentId !== body.environmentId ||
          previous.sessionId !== body.sessionId)
      ) {
        return json({ error: "Runtime identity conflict" }, 409)
      }
      const metadata: RuntimeMetadata = {
        subject: body.subject,
        environmentId: body.environmentId,
        sessionId: body.sessionId,
        environmentGeneration: body.environmentGeneration,
        authStateVersion: body.authStateVersion,
        sessionGeneration: previous?.sessionGeneration ?? 1,
        processId: previous?.processId ?? null,
        authorized: true,
        harness: previous?.harness ?? null,
        codexCapabilityHandle:
          typeof body.codexCapabilityHandle === "string"
            ? body.codexCapabilityHandle
            : body.codexCapabilityHandle === null
              ? null
              : previous?.codexCapabilityHandle ?? null,
        claudeCapabilityHandle:
          typeof body.claudeCapabilityHandle === "string"
            ? body.claudeCapabilityHandle
            : body.claudeCapabilityHandle === null
              ? null
              : previous?.claudeCapabilityHandle ?? null,
        githubCapabilityHandle:
          typeof body.githubCapabilityHandle === "string"
            ? body.githubCapabilityHandle
            : body.githubCapabilityHandle === null
              ? null
              : previous?.githubCapabilityHandle ?? null,
        repositorySlug:
          typeof body.repositorySlug === "string"
            ? body.repositorySlug
            : previous?.repositorySlug ?? null,
        providerTokenHash: previous?.providerTokenHash ?? null,
        gitTokenHash: previous?.gitTokenHash ?? null,
        usageReservationId:
          typeof body.reservationId === "string"
            ? body.reservationId
            : previous?.usageReservationId ?? null,
        usageStartedAt:
          typeof body.reservationId === "string" &&
          body.reservationId !== previous?.usageReservationId
            ? null
            : previous?.usageStartedAt ?? null,
        checkpoint: previous?.checkpoint ?? null
      }
      await this.ctx.storage.put(METADATA_KEY, metadata)
      return json({ sessionGeneration: metadata.sessionGeneration })
    }

    if (url.pathname === "/v1/auth-state" && request.method === "POST") {
      const body = fields(await request.json())
      const snapshot = decodeManagedAuthSnapshot(body?.snapshot)
      const metadata = await this.#metadata()
      if (metadata !== null) {
        const now = Math.floor(Date.now() / 1_000)
        const codexCapability = snapshot?.credentialCapabilities.find(
          (capability) => capability.provider === "codex" && capability.expiresAt > now
        )
        const claudeCapability = snapshot?.credentialCapabilities.find(
          (capability) => capability.provider === "claude" && capability.expiresAt > now
        )
        const authorized =
          snapshot?.capabilities.includes("managed.session.execute") === true &&
          (metadata.harness === "codex"
            ? codexCapability !== undefined
            : metadata.harness === "claude"
              ? claudeCapability !== undefined
              : codexCapability !== undefined || claudeCapability !== undefined) &&
          (snapshot?.expiresAt ?? 0) > now
        const next = await applyManagedAuthorizationSnapshot(
          metadata,
          authorized ? (snapshot?.version ?? null) : null,
          async () => this.#terminateProcess(metadata, "authorization-revoked")
        )
        await this.ctx.storage.put(METADATA_KEY, {
          ...next,
          codexCapabilityHandle: codexCapability?.handle ?? null,
          claudeCapabilityHandle: claudeCapability?.handle ?? null,
          githubCapabilityHandle:
            snapshot?.credentialCapabilities.find(
              (capability) =>
                capability.provider === "github" &&
                capability.expiresAt > now
            )?.handle ?? null
        })
        if (metadata.processId !== null && next.processId === null) {
          await this.#settleUsage()
          await this.#unregisterSession(metadata)
        }
      }
      return json({ ok: true })
    }

    const metadata = await this.#metadata()
    if (metadata === null) return json({ error: "Runtime is not configured" }, 409)

    if (url.pathname === "/v1/destroy" && request.method === "POST") {
      const body = fields(await request.json())
      if (
        body?.subject !== metadata.subject ||
        body.environmentId !== metadata.environmentId
      ) {
        return json({ error: "Runtime identity conflict" }, 403)
      }
      await this.#terminateProcess(metadata, "environment-destroyed")
      await this.#settleUsage()
      const sandbox = getSandbox(this.env.Sandbox, metadata.sessionId, {
        transport: "rpc",
        normalizeId: true,
        enableDefaultSession: false,
        sleepAfter: `${this.env.MANAGED_RUNTIME_IDLE_SECONDS}s`
      })
      await sandbox.destroy().catch(() => undefined)
      await this.#unregisterSession(metadata)
      await this.ctx.storage.deleteAll()
      return json({ destroyed: true })
    }

    if (url.pathname === "/v1/commands" && request.method === "POST") {
      const decoded = Schema.decodeUnknownEither(RemoteSessionCommandSchema)(
        await request.json(),
        { onExcessProperty: "error" }
      )
      if (Either.isLeft(decoded)) return json({ error: "Invalid command" }, 400)
      const command = decoded.right
      const verification = await this.#authorize(
        request,
        metadata,
        managedRuntimeActionForOperation(command.operation)
      )
      if (!verification.ok) return json({ error: verification.reason }, 403)
      if (command.sessionId !== metadata.sessionId) return json({ error: "wrong-scope" }, 403)
      const admission = await this.#mutateJournal((journal) => journal.admit(command))
      if (admission === "started") {
        this.ctx.waitUntil(this.#scheduleExecution(command))
      }
      return json({ accepted: true, replay: admission === "replay" }, 202)
    }

    const providerAuthorization = url.pathname.match(
      /^\/v1\/provider-authorization\/(codex|claude)$/u
    )
    if (providerAuthorization !== null && request.method === "POST") {
      const token = bearerManagedGrant(request)
      const capabilityHandle = providerAuthorization[1] === "claude"
        ? metadata.claudeCapabilityHandle
        : metadata.codexCapabilityHandle
      const tokenMatches =
        token !== null &&
        metadata.providerTokenHash !== null &&
        (await sha256(token)) === metadata.providerTokenHash
      if (
        !metadata.authorized ||
        metadata.harness !== providerAuthorization[1] ||
        metadata.processId === null ||
        !tokenMatches ||
        capabilityHandle === null
      ) {
        console.warn(JSON.stringify({
          component: "managed-session-runtime",
          event: "provider_authorization_denied",
          provider: providerAuthorization[1],
          authorized: metadata.authorized,
          harnessMatches: metadata.harness === providerAuthorization[1],
          processActive: metadata.processId !== null,
          tokenPresent: token !== null,
          tokenMatches,
          capabilityPresent: capabilityHandle !== null
        }))
        return json({ error: "Provider authorization unavailable" }, 403)
      }
      return json({
        subject: metadata.subject,
        capabilityHandle
      })
    }

    if (url.pathname === "/v1/git-token" && request.method === "POST") {
      if (
        !metadata.authorized ||
        metadata.githubCapabilityHandle === null ||
        typeof metadata.repositorySlug !== "string"
      ) {
        return json({ error: "Git authorization unavailable" }, 403)
      }
      const token = `git_${crypto.randomUUID().replaceAll("-", "")}`
      await this.ctx.storage.put(METADATA_KEY, {
        ...metadata,
        gitTokenHash: await sha256(token)
      })
      return json({ token })
    }

    if (url.pathname === "/v1/git-token/revoke" && request.method === "POST") {
      await this.ctx.storage.put(METADATA_KEY, { ...metadata, gitTokenHash: null })
      return json({ ok: true })
    }

    if (url.pathname === "/v1/git-authorization" && request.method === "POST") {
      const token = bearerManagedGrant(request)
      if (
        !metadata.authorized ||
        token === null ||
        metadata.gitTokenHash === null ||
        (await sha256(token)) !== metadata.gitTokenHash ||
        metadata.githubCapabilityHandle === null
      ) {
        return json({ error: "Git authorization unavailable" }, 403)
      }
      return json({
        subject: metadata.subject,
        capabilityHandle: metadata.githubCapabilityHandle,
        repositorySlug: metadata.repositorySlug
      })
    }

    if (url.pathname === "/v1/events" && request.method === "GET") {
      const verification = await this.#authorize(request, metadata, "session.observe")
      if (!verification.ok) return json({ error: verification.reason }, 403)
      const commandId = url.searchParams.get("commandId")
      const after = Number(url.searchParams.get("after") ?? -1)
      if (commandId === null || !Number.isSafeInteger(after)) {
        return json({ error: "Invalid replay cursor" }, 400)
      }
      const journal = await this.#journal()
      const events = journal.replay(commandId, after)
      if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
        return json({ events })
      }
      const pair = new WebSocketPair()
      const sockets = Object.values(pair)
      const client = sockets[0]
      const server = sockets[1]
      if (client === undefined || server === undefined) {
        return json({ error: "WebSocket unavailable" }, 503)
      }
      this.ctx.acceptWebSocket(server, [commandId])
      for (const event of events) server.send(JSON.stringify(event))
      // Do not close in the same task that sends a terminal frame. Cloudflare's
      // WebSocket implementation may flush the close before the queued message,
      // leaving the observer with a clean 1000 close but no terminal event. The
      // client owns the stream lifetime and closes as soon as it consumes the
      // durable terminal frame; hibernation keeps an idle replay socket cheap in
      // the narrow interval before that happens.
      return new Response(null, { status: 101, webSocket: client })
    }

    if (url.pathname === "/v1/cancel" && request.method === "POST") {
      const verification = await this.#authorize(request, metadata, "session.cancel")
      if (!verification.ok) return json({ error: verification.reason }, 403)
      await this.#stopActive("cancelled")
      return json({ ok: true })
    }

    return json({ error: "Not found" }, 404)
  }
}
