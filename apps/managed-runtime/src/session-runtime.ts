import {
  ManagedRuntimeProviderSelection,
  managedRuntimeActionForOperation,
  type ManagedProviderCapability as ManagedProviderCapabilityValue,
  type ManagedWebSearchCapability,
  type ManagedRuntimeProviderSelection as ManagedRuntimeProviderSelectionValue,
  type ManagedRuntimeAction,
  type RemoteSessionCommand,
  type RemoteSessionEvent,
} from "@jingler/core";
import { RemoteSessionCommand as RemoteSessionCommandSchema } from "@jingler/core";
import { getSandbox } from "@cloudflare/sandbox";
import { DurableObject } from "cloudflare:workers";
import { Either, Schema } from "effect";
import {
  decodeManagedAuthSnapshot,
  hasSameProviderRoute,
  managedWebSearchRouteChanged,
} from "./auth-subscription.js";
import {
  bearerManagedGrant,
  verifyManagedRuntimeGrant,
  type ManagedGrantVerification,
} from "./grant.js";
import { applyManagedAuthorizationSnapshot } from "./authorization.js";
import {
  emptyManagedSessionJournal,
  ManagedSessionJournal,
  type ManagedSessionJournalState,
} from "./session-journal.js";
import {
  managedRuntimeSandboxOrigin,
  type ManagedRuntimeEnv,
} from "./runtime-env.js";
import { redactedUsageTelemetry, shouldSampleUsage } from "./usage-policy.js";
import {
  createWorkspaceCheckpoint,
  type WorkspaceCheckpointManifest,
} from "./workspace-checkpoint.js";
import { r2CheckpointStore } from "./r2-checkpoint-store.js";
import { fields, json } from "./worker-http.js";
import { managedProviderEnvironment } from "./provider-session-config.js";
import { ManagedExecutionScheduler } from "./execution-scheduler.js";
import { ManagedRuntimeConfiguration } from "./runtime-configuration.js";
import { unstreamedProcessOutput } from "./process-output.js";
import { sandboxIdForSession, sha256Hex } from "./runtime-identity.js";
import { managedCertificationDocument } from "./certification-config.js";
import { INTERNAL_ROUTES } from "./internal-routes.js";

interface RuntimeMetadata {
  readonly subject: string;
  readonly environmentId: string;
  readonly sessionId: string;
  readonly environmentGeneration: number;
  readonly sessionGeneration: number;
  readonly authStateVersion: number;
  readonly processId: string | null;
  readonly authorized: boolean;
  readonly providerConnection: ManagedProviderCapabilityValue;
  readonly modelId: ManagedRuntimeProviderSelectionValue["modelId"];
  readonly webSearchCapabilities?: ReadonlyArray<ManagedWebSearchCapability>;
  readonly githubCapabilityHandle: string | null;
  readonly repositorySlug: string | null;
  readonly providerTokenHash: string | null;
  readonly gitTokenHash: string | null;
  readonly usageReservationId: string | null;
  readonly usageStartedAt: number | null;
  readonly checkpoint: WorkspaceCheckpointManifest | null;
}

const METADATA_KEY = "runtime-metadata";
const JOURNAL_KEY = "session-journal";
const PROVIDER_AUTHORIZATION_PATH =
  /^\/v1\/provider-authorization\/(codex|claude)$/u;
const WEB_SEARCH_AUTHORIZATION_PATH =
  /^\/v1\/web-search-authorization\/(exa|firecrawl)$/u;

const shellQuote = (value: string): string =>
  `'${value.replaceAll("'", "'\\''")}'`;

const ContinuationProviderSelection = Schema.Struct({
  sourceSession: ManagedRuntimeProviderSelection,
});

const commandProviderSelection = (
  command: RemoteSessionCommand,
): ManagedRuntimeProviderSelectionValue | null => {
  if (command.operation === "Sessions.continueOnEnvironment") {
    const decoded = Schema.decodeUnknownEither(ContinuationProviderSelection)(
      command.payload,
      { onExcessProperty: "ignore" },
    );
    return Either.isRight(decoded) ? decoded.right.sourceSession : null;
  }
  if (
    command.operation !== "Sessions.create" &&
    command.operation !== "Sessions.createFromPr" &&
    command.operation !== "Sessions.createFromIssue"
  ) {
    return null;
  }
  const decoded = Schema.decodeUnknownEither(ManagedRuntimeProviderSelection)(
    command.payload,
    { onExcessProperty: "ignore" },
  );
  return Either.isRight(decoded) ? decoded.right : null;
};

export const decodeManagedCommandFrame = (
  value: unknown,
):
  | {
      readonly type: "managed-event";
      readonly event: { readonly kind: "event"; readonly payload: unknown };
    }
  | {
      readonly type: "managed-complete" | "managed-failed";
      readonly payload: unknown;
    }
  | null => {
  const frame = fields(value);
  if (frame?.type === "managed-event") {
    const event = fields(frame.event);
    return event?.kind === "event"
      ? {
          type: "managed-event",
          event: { kind: "event", payload: event.payload },
        }
      : null;
  }
  return frame?.type === "managed-complete" || frame?.type === "managed-failed"
    ? { type: frame.type, payload: frame.payload }
    : null;
};

export class ManagedSessionObject extends DurableObject<ManagedRuntimeEnv> {
  #journalTail: Promise<void> = Promise.resolve();
  readonly #execution = new ManagedExecutionScheduler<RemoteSessionCommand>(
    (command) => this.#execute(command),
  );

  async #metadata(): Promise<RuntimeMetadata | null> {
    return (await this.ctx.storage.get<RuntimeMetadata>(METADATA_KEY)) ?? null;
  }

  async #journal(): Promise<ManagedSessionJournal> {
    const restored =
      (await this.ctx.storage.get<ManagedSessionJournalState>(JOURNAL_KEY)) ??
      emptyManagedSessionJournal();
    return new ManagedSessionJournal(restored);
  }

  async #persistJournal(journal: ManagedSessionJournal): Promise<void> {
    await this.ctx.storage.put(JOURNAL_KEY, journal.snapshot());
  }

  #mutateJournal<Value>(
    mutation: (journal: ManagedSessionJournal) => Value,
  ): Promise<Value> {
    const result = this.#journalTail.then(async () => {
      const journal = await this.#journal();
      const value = mutation(journal);
      await this.#persistJournal(journal);
      return value;
    });
    this.#journalTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  #scheduleExecution(command: RemoteSessionCommand): Promise<void> {
    return this.#execution.schedule(
      command,
      managedRuntimeActionForOperation(command.operation) === "session.observe"
        ? "observe"
        : "mutate",
    );
  }

  async #authorize(
    request: Request,
    metadata: RuntimeMetadata,
    action: ManagedRuntimeAction,
  ): Promise<ManagedGrantVerification> {
    if (!metadata.authorized) {
      return { ok: false, reason: "wrong-auth-version" };
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
        sessionId: metadata.sessionId,
      },
    );
  }

  async #append(
    commandId: string,
    event: Omit<
      RemoteSessionEvent,
      "version" | "commandId" | "sessionId" | "eventSequence"
    >,
  ): Promise<void> {
    const value = await this.#mutateJournal((journal) =>
      journal.append(commandId, event),
    );
    this.#broadcast(commandId, value);
  }

  #broadcast(commandId: string, event: RemoteSessionEvent): void {
    for (const socket of this.ctx.getWebSockets(commandId)) {
      try {
        socket.send(JSON.stringify(event));
      } catch {
        socket.close(1011, "delivery-failed");
      }
    }
  }

  async #settle(
    commandId: string,
    status: "complete" | "failed" | "cancelled",
    payload: unknown,
    checkpoint: boolean,
  ): Promise<void> {
    const terminal = await this.#settleJournal(commandId, status, payload);
    this.#broadcast(commandId, terminal);
    if (checkpoint) await this.#checkpoint(terminal.eventSequence);
    const metadata = await this.#metadata();
    if (metadata !== null) {
      await this.ctx.storage.put(METADATA_KEY, {
        ...metadata,
        processId: null,
        providerTokenHash: null,
      });
      await this.#settleUsage();
      await this.#unregisterSession(metadata);
    }
  }

  #settleJournal(
    commandId: string,
    status: "complete" | "failed" | "cancelled",
    payload: unknown,
  ): Promise<RemoteSessionEvent> {
    return this.#mutateJournal((journal) =>
      journal.settle(commandId, status, payload),
    );
  }

  async #checkpoint(eventCursor: number): Promise<void> {
    const metadata = await this.#metadata();
    if (metadata === null) return;
    const sandbox = getSandbox(
      this.env.Sandbox,
      await sandboxIdForSession(metadata.sessionId),
      {
        transport: "rpc",
        normalizeId: true,
        enableDefaultSession: false,
        sleepAfter: `${this.env.MANAGED_RUNTIME_IDLE_SECONDS}s`,
      },
    );
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
          retentionSeconds: Number(
            this.env.MANAGED_RUNTIME_CHECKPOINT_RETENTION_SECONDS,
          ),
          maxBytes: Number(this.env.MANAGED_RUNTIME_MAX_CHECKPOINT_BYTES),
        },
      );
      await this.ctx.storage.put(METADATA_KEY, {
        ...metadata,
        checkpoint: result.manifest,
      });
    } catch {
      // The turn is already durable in the event journal. A later settled turn
      // retries the content-aware checkpoint without delaying client delivery.
    }
  }

  async #settleUsage(): Promise<void> {
    const metadata = await this.#metadata();
    if (metadata === null || metadata.usageReservationId === null) return;
    const activeSeconds = Math.min(
      Number(this.env.MANAGED_RUNTIME_MAX_ACTIVE_SECONDS),
      Math.max(
        0,
        Math.ceil(
          (Date.now() - (metadata.usageStartedAt ?? Date.now())) / 1_000,
        ),
      ),
    );
    try {
      const response = await fetch(
        new URL(
          "/api/internal/managed-usage/settle",
          this.env.MANAGED_CONTROL_PLANE_URL,
        ),
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-jingler-service-secret": this.env.MANAGED_RUNTIME_SERVICE_SECRET,
          },
          body: JSON.stringify({
            userId: metadata.subject,
            reservationId: metadata.usageReservationId,
            activeSeconds,
          }),
        },
      );
      if (!response.ok)
        throw new Error(`usage settlement returned ${response.status}`);
      await this.ctx.storage.put(METADATA_KEY, {
        ...metadata,
        usageReservationId: null,
        usageStartedAt: null,
      });
      if (shouldSampleUsage(metadata.usageReservationId)) {
        console.log(
          JSON.stringify(
            redactedUsageTelemetry({
              activeSeconds,
              cleanup: "completed",
            }),
          ),
        );
      }
    } catch {
      await this.ctx.storage.setAlarm(Date.now() + 60_000);
    }
  }

  async #unregisterSession(metadata: RuntimeMetadata): Promise<void> {
    await this.env.MANAGED_ACCOUNT.getByName(metadata.subject)
      .fetch(INTERNAL_ROUTES.managedAccount.sessionUnregister, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          subject: metadata.subject,
          sessionId: metadata.sessionId,
        }),
      })
      .catch(() => undefined);
  }

  override async alarm(): Promise<void> {
    await this.#settleUsage();
  }

  async #execute(command: RemoteSessionCommand): Promise<void> {
    const sandbox = getSandbox(
      this.env.Sandbox,
      await sandboxIdForSession(command.sessionId),
      {
        transport: "rpc",
        normalizeId: true,
        enableDefaultSession: false,
        sleepAfter: `${this.env.MANAGED_RUNTIME_IDLE_SECONDS}s`,
      },
    );
    const inputDirectory = "/tmp/jingler-commands";
    const inputFile = `${inputDirectory}/${await sha256Hex(command.commandId)}.json`;
    let phase = "preparing command input";
    const checkpoint =
      managedRuntimeActionForOperation(command.operation) !== "session.observe";
    let disposeProcess: (() => void) | null = null;
    try {
      await sandbox.mkdir(inputDirectory, { recursive: true });
      await sandbox.writeFile(inputFile, JSON.stringify(command));
      const certifications = managedCertificationDocument(
        this.env.MANAGED_RUNTIME_CERTIFICATIONS_BASE64,
      );
      if (this.env.MANAGED_RUNTIME_CERTIFICATIONS_BASE64 && !certifications) {
        throw new Error("Managed runtime certifications are invalid");
      }
      if (certifications) {
        const runtimeDirectory = "/workspace/.jingler-runtime/runtime";
        await sandbox.mkdir(runtimeDirectory, { recursive: true });
        await sandbox.writeFile(
          `${runtimeDirectory}/certifications.json`,
          certifications,
        );
      }
      const metadata = await this.#metadata();
      if (metadata === null)
        throw new Error("Managed runtime metadata disappeared");
      const selection = commandProviderSelection(command);
      if (
        selection !== null &&
        (selection.connectionId !== metadata.providerConnection.connectionId ||
          selection.providerId !== metadata.providerConnection.providerId ||
          selection.modelId !== metadata.modelId)
      ) {
        throw new Error(
          "Managed command provider selection does not match the configured session",
        );
      }
      if (
        !metadata.authorized ||
        metadata.providerConnection.expiresAt <= Date.now() / 1_000
      ) {
        throw new Error("Managed provider connection is unavailable");
      }
      const processEnv = managedProviderEnvironment({
        capability: metadata.providerConnection,
        origin: managedRuntimeSandboxOrigin(this.env),
        sessionId: command.sessionId,
        nonce: crypto.randomUUID().replaceAll("-", ""),
        webSearchProvider: (metadata.webSearchCapabilities ?? [])[0]?.provider,
      });
      await this.ctx.storage.put(METADATA_KEY, {
        ...metadata,
        processId: command.commandId,
        providerTokenHash: await sha256Hex(processEnv.JINGLER_PROVIDER_ACCESS),
        usageStartedAt: metadata.usageStartedAt ?? Date.now(),
      });
      const commandLine = [
        "node",
        "/opt/jingler/jingler-device.mjs",
        "managed-command",
        "--root",
        "/workspace/.jingler-runtime",
        "--target-id",
        shellQuote(metadata.environmentId),
        "--input",
        shellQuote(inputFile),
      ].join(" ");
      let settled = false;
      let buffered = "";
      const admitOutput = async (chunk: string): Promise<void> => {
        buffered += chunk;
        while (true) {
          const newline = buffered.indexOf("\n");
          if (newline < 0) return;
          const line = buffered.slice(0, newline);
          buffered = buffered.slice(newline + 1);
          if (!line) continue;
          let frame: ReturnType<typeof decodeManagedCommandFrame> = null;
          try {
            frame = decodeManagedCommandFrame(JSON.parse(line));
          } catch {
            // The command runner emits protocol frames on stdout only. Ignore
            // non-protocol dependency noise rather than relaying secrets/logs.
          }
          if (frame?.type === "managed-event") {
            await this.#append(command.commandId, frame.event);
          } else if (frame?.type === "managed-complete") {
            await this.#settle(
              command.commandId,
              "complete",
              frame.payload,
              checkpoint,
            );
            settled = true;
          } else if (frame?.type === "managed-failed") {
            await this.#settle(
              command.commandId,
              "failed",
              frame.payload,
              checkpoint,
            );
            settled = true;
          }
        }
      };

      // Only a real agent turn needs incremental output. Conversation bootstrap,
      // file/diff reads and lifecycle mutations return one bounded protocol
      // result, so a single RPC exec is both cheaper and immune to the SDK's
      // long-lived ReadableStream transport edge cases.
      if (command.operation !== "Agent.run") {
        phase = "running the bounded command";
        const result = await sandbox.exec(commandLine, {
          cwd: "/workspace",
          env: processEnv,
          timeout: Number(this.env.MANAGED_RUNTIME_MAX_ACTIVE_SECONDS) * 1_000,
        });
        await admitOutput(
          result.stdout.endsWith("\n") ? result.stdout : `${result.stdout}\n`,
        );
        if (!settled) {
          await this.#settle(
            command.commandId,
            "failed",
            {
              code: "runtime-protocol-ended",
              message: `Managed command runner exited without a terminal frame (${result.exitCode}).`,
            },
            checkpoint,
          );
        }
        return;
      }

      phase = "starting the pi runtime process";
      let outputTail = Promise.resolve();
      let streamedStdout = "";
      let acceptStreamOutput = true;
      const process = await sandbox.startProcess(commandLine, {
        cwd: "/workspace",
        sessionId: "jingler-session",
        processId: command.commandId,
        autoCleanup: false,
        env: processEnv,
        onOutput: (stream, data) => {
          if (stream !== "stdout" || !acceptStreamOutput) return;
          streamedStdout += data;
          outputTail = outputTail.then(() => admitOutput(data));
        },
      });
      const dispose = Reflect.get(process, Symbol.dispose);
      if (typeof dispose === "function") {
        disposeProcess = () => Reflect.apply(dispose, process, []);
      }
      phase = "waiting for pi runtime completion";
      const exited = await process.waitForExit(
        Number(this.env.MANAGED_RUNTIME_MAX_ACTIVE_SECONDS) * 1_000,
      );
      const retained = await process.getLogs();
      acceptStreamOutput = false;
      await outputTail;
      await admitOutput(
        unstreamedProcessOutput(streamedStdout, retained.stdout),
      );
      if (buffered.trim().length > 0) await admitOutput("\n");
      if (!settled) {
        await this.#settle(
          command.commandId,
          "failed",
          {
            code: "runtime-protocol-ended",
            message: `Managed command runner exited without a terminal frame (${exited.exitCode ?? "unknown"}).`,
          },
          checkpoint,
        );
      }
    } catch (cause) {
      await this.#settle(
        command.commandId,
        "failed",
        {
          code: "runtime-failed",
          message:
            cause instanceof Error
              ? `Managed runtime failed while ${phase}: ${cause.message}`
              : `Managed runtime failed while ${phase}`,
        },
        checkpoint,
      ).catch(() => undefined);
    } finally {
      disposeProcess?.();
      await sandbox.deleteFile(inputFile).catch(() => undefined);
    }
  }

  async #stopActive(reason: string): Promise<void> {
    const metadata = await this.#metadata();
    if (metadata === null) return;
    await this.#terminateProcess(metadata, reason);
    await this.ctx.storage.put(METADATA_KEY, {
      ...metadata,
      processId: null,
      providerTokenHash: null,
      sessionGeneration: metadata.sessionGeneration + 1,
    });
    await this.#settleUsage();
    await this.#unregisterSession(metadata);
  }

  async #terminateProcess(
    metadata: RuntimeMetadata,
    reason: string,
  ): Promise<void> {
    if (metadata.processId === null) return;
    const sandbox = getSandbox(
      this.env.Sandbox,
      await sandboxIdForSession(metadata.sessionId),
      {
        transport: "rpc",
        normalizeId: true,
        enableDefaultSession: false,
        sleepAfter: `${this.env.MANAGED_RUNTIME_IDLE_SECONDS}s`,
      },
    );
    await sandbox.killProcess(metadata.processId).catch(() => undefined);
    try {
      const terminal = await this.#settleJournal(
        metadata.processId,
        "cancelled",
        {
          reason,
        },
      );
      this.#broadcast(metadata.processId, terminal);
      await this.#checkpoint(terminal.eventSequence);
    } catch {
      // A concurrently completing process may already have durably settled.
    }
  }

  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/v1/configure" && request.method === "POST") {
      const decoded = Schema.decodeUnknownEither(ManagedRuntimeConfiguration)(
        await request.json(),
        { onExcessProperty: "error" },
      );
      if (Either.isLeft(decoded)) {
        return json({ error: "Invalid runtime configuration" }, 400);
      }
      const body = decoded.right;
      if (
        body.providerConnection.connectionId !== body.connectionId ||
        body.providerConnection.providerId !== body.providerId
      ) {
        return json({ error: "Provider connection selection mismatch" }, 400);
      }
      const previous = await this.#metadata();
      if (
        previous !== null &&
        (previous.subject !== body.subject ||
          previous.environmentId !== body.environmentId ||
          previous.sessionId !== body.sessionId)
      ) {
        return json({ error: "Runtime identity conflict" }, 409);
      }
      if (
        previous !== null &&
        previous.processId !== null &&
        (previous.providerConnection.connectionId !== body.connectionId ||
          previous.providerConnection.providerId !== body.providerId ||
          previous.modelId !== body.modelId)
      ) {
        return json(
          {
            error: "Cannot switch provider selection during an active command",
          },
          409,
        );
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
        providerConnection: body.providerConnection,
        modelId: body.modelId,
        webSearchCapabilities: body.webSearchCapabilities,
        githubCapabilityHandle: body.githubCapabilityHandle,
        repositorySlug: body.repositorySlug ?? previous?.repositorySlug ?? null,
        providerTokenHash: previous?.providerTokenHash ?? null,
        gitTokenHash: previous?.gitTokenHash ?? null,
        usageReservationId:
          body.reservationId ?? previous?.usageReservationId ?? null,
        usageStartedAt:
          body.reservationId !== null &&
          body.reservationId !== previous?.usageReservationId
            ? null
            : (previous?.usageStartedAt ?? null),
        checkpoint: previous?.checkpoint ?? null,
      };
      await this.ctx.storage.put(METADATA_KEY, metadata);
      return json({ sessionGeneration: metadata.sessionGeneration });
    }

    if (url.pathname === "/v1/auth-state" && request.method === "POST") {
      const body = fields(await request.json());
      const snapshot = decodeManagedAuthSnapshot(body?.snapshot);
      const metadata = await this.#metadata();
      if (metadata !== null) {
        const now = Math.floor(Date.now() / 1_000);
        const providerConnection = snapshot?.providerConnections.find(
          (capability) =>
            hasSameProviderRoute(metadata.providerConnection, capability) &&
            capability.expiresAt > now,
        );
        const authorized =
          snapshot?.capabilities.includes("managed.session.execute") === true &&
          providerConnection !== undefined &&
          (snapshot?.expiresAt ?? 0) > now;
        const next = await applyManagedAuthorizationSnapshot(
          metadata,
          authorized ? (snapshot?.version ?? null) : null,
          async () => this.#terminateProcess(metadata, "authorization-revoked"),
        );
        const webSearchCapabilities =
          snapshot?.credentialCapabilities.flatMap((capability) =>
            (capability.provider === "exa" || capability.provider === "firecrawl") &&
            capability.expiresAt > now
              ? [{
                  provider: capability.provider,
                  handle: capability.handle,
                  expiresAt: capability.expiresAt
                }]
              : []
          ) ?? [];
        const searchRouteChanged = managedWebSearchRouteChanged(
          metadata.webSearchCapabilities,
          webSearchCapabilities,
        );
        if (searchRouteChanged && next.processId !== null) {
          await this.#terminateProcess(metadata, "web-search-route-changed");
        }
        const processId = searchRouteChanged ? null : next.processId;
        await this.ctx.storage.put(METADATA_KEY, {
          ...next,
          processId,
          providerConnection: providerConnection ?? metadata.providerConnection,
          webSearchCapabilities,
          githubCapabilityHandle:
            snapshot?.credentialCapabilities.find(
              (capability) =>
                capability.provider === "github" && capability.expiresAt > now,
            )?.handle ?? null,
        });
        if (metadata.processId !== null && processId === null) {
          await this.#settleUsage();
          await this.#unregisterSession(metadata);
        }
      }
      return json({ ok: true });
    }

    const metadata = await this.#metadata();
    if (metadata === null)
      return json({ error: "Runtime is not configured" }, 409);

    if (url.pathname === "/v1/destroy" && request.method === "POST") {
      const body = fields(await request.json());
      if (
        body?.subject !== metadata.subject ||
        body.environmentId !== metadata.environmentId
      ) {
        return json({ error: "Runtime identity conflict" }, 403);
      }
      await this.#terminateProcess(metadata, "environment-destroyed");
      await this.#settleUsage();
      const sandbox = getSandbox(
        this.env.Sandbox,
        await sandboxIdForSession(metadata.sessionId),
        {
          transport: "rpc",
          normalizeId: true,
          enableDefaultSession: false,
          sleepAfter: `${this.env.MANAGED_RUNTIME_IDLE_SECONDS}s`,
        },
      );
      await sandbox.destroy().catch(() => undefined);
      await this.#unregisterSession(metadata);
      await this.ctx.storage.deleteAll();
      return json({ destroyed: true });
    }

    if (url.pathname === "/v1/commands" && request.method === "POST") {
      const decoded = Schema.decodeUnknownEither(RemoteSessionCommandSchema)(
        await request.json(),
        { onExcessProperty: "error" },
      );
      if (Either.isLeft(decoded))
        return json({ error: "Invalid command" }, 400);
      const command = decoded.right;
      const verification = await this.#authorize(
        request,
        metadata,
        managedRuntimeActionForOperation(command.operation),
      );
      if (!verification.ok) return json({ error: verification.reason }, 403);
      if (command.sessionId !== metadata.sessionId)
        return json({ error: "wrong-scope" }, 403);
      const admission = await this.#mutateJournal((journal) =>
        journal.admit(command),
      );
      if (admission === "started") {
        this.ctx.waitUntil(this.#scheduleExecution(command));
      }
      return json({ accepted: true, replay: admission === "replay" }, 202);
    }

    const providerAuthorization = url.pathname.match(
      PROVIDER_AUTHORIZATION_PATH,
    );
    if (providerAuthorization !== null && request.method === "POST") {
      const token = bearerManagedGrant(request);
      const tokenMatches =
        token !== null &&
        metadata.providerTokenHash !== null &&
        (await sha256Hex(token)) === metadata.providerTokenHash;
      if (
        !metadata.authorized ||
        metadata.providerConnection.proxy !== providerAuthorization[1] ||
        metadata.processId === null ||
        !tokenMatches
      ) {
        console.warn(
          JSON.stringify({
            component: "managed-session-runtime",
            event: "provider_authorization_denied",
            provider: providerAuthorization[1],
            authorized: metadata.authorized,
            providerMatches:
              metadata.providerConnection.proxy === providerAuthorization[1],
            processActive: metadata.processId !== null,
            tokenPresent: token !== null,
            tokenMatches,
          }),
        );
        return json({ error: "Provider authorization unavailable" }, 403);
      }
      return json({
        subject: metadata.subject,
        capabilityHandle: metadata.providerConnection.handle,
      });
    }

    const webSearchAuthorization = url.pathname.match(
      WEB_SEARCH_AUTHORIZATION_PATH,
    );
    if (webSearchAuthorization !== null && request.method === "POST") {
      const token = bearerManagedGrant(request);
      const tokenMatches =
        token !== null &&
        metadata.providerTokenHash !== null &&
        (await sha256Hex(token)) === metadata.providerTokenHash;
      const capability = (metadata.webSearchCapabilities ?? []).find(
        (candidate) => candidate.provider === webSearchAuthorization[1],
      );
      if (
        !metadata.authorized ||
        metadata.processId === null ||
        !tokenMatches ||
        capability === undefined ||
        capability.expiresAt <= Math.floor(Date.now() / 1_000)
      ) {
        return json({ error: "WebSearch authorization unavailable" }, 403);
      }
      return json({
        subject: metadata.subject,
        capabilityHandle: capability.handle,
      });
    }

    if (url.pathname === "/v1/git-token" && request.method === "POST") {
      if (
        !metadata.authorized ||
        metadata.githubCapabilityHandle === null ||
        typeof metadata.repositorySlug !== "string"
      ) {
        return json({ error: "Git authorization unavailable" }, 403);
      }
      const token = `git_${crypto.randomUUID().replaceAll("-", "")}`;
      await this.ctx.storage.put(METADATA_KEY, {
        ...metadata,
        gitTokenHash: await sha256Hex(token),
      });
      return json({ token });
    }

    if (url.pathname === "/v1/git-token/revoke" && request.method === "POST") {
      await this.ctx.storage.put(METADATA_KEY, {
        ...metadata,
        gitTokenHash: null,
      });
      return json({ ok: true });
    }

    if (url.pathname === "/v1/git-authorization" && request.method === "POST") {
      const token = bearerManagedGrant(request);
      if (
        !metadata.authorized ||
        token === null ||
        metadata.gitTokenHash === null ||
        (await sha256Hex(token)) !== metadata.gitTokenHash ||
        metadata.githubCapabilityHandle === null
      ) {
        return json({ error: "Git authorization unavailable" }, 403);
      }
      return json({
        subject: metadata.subject,
        capabilityHandle: metadata.githubCapabilityHandle,
        repositorySlug: metadata.repositorySlug,
      });
    }

    if (url.pathname === "/v1/events" && request.method === "GET") {
      const verification = await this.#authorize(
        request,
        metadata,
        "session.observe",
      );
      if (!verification.ok) return json({ error: verification.reason }, 403);
      const commandId = url.searchParams.get("commandId");
      const after = Number(url.searchParams.get("after") ?? -1);
      if (commandId === null || !Number.isSafeInteger(after)) {
        return json({ error: "Invalid replay cursor" }, 400);
      }
      const journal = await this.#journal();
      const events = journal.replay(commandId, after);
      if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
        return json({ events });
      }
      const pair = new WebSocketPair();
      const sockets = Object.values(pair);
      const client = sockets[0];
      const server = sockets[1];
      if (client === undefined || server === undefined) {
        return json({ error: "WebSocket unavailable" }, 503);
      }
      this.ctx.acceptWebSocket(server, [commandId]);
      for (const event of events) server.send(JSON.stringify(event));
      // Do not close in the same task that sends a terminal frame. Cloudflare's
      // WebSocket implementation may flush the close before the queued message,
      // leaving the observer with a clean 1000 close but no terminal event. The
      // client owns the stream lifetime and closes as soon as it consumes the
      // durable terminal frame; hibernation keeps an idle replay socket cheap in
      // the narrow interval before that happens.
      return new Response(null, { status: 101, webSocket: client });
    }

    if (url.pathname === "/v1/cancel" && request.method === "POST") {
      const verification = await this.#authorize(
        request,
        metadata,
        "session.cancel",
      );
      if (!verification.ok) return json({ error: verification.reason }, 403);
      await this.#stopActive("cancelled");
      return json({ ok: true });
    }

    return json({ error: "Not found" }, 404);
  }
}
