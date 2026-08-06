import {
  encodeGitHubRelayClientMessage,
  parseGitHubRelayServerMessage,
  type GitHubRelayEvent,
} from "../../../../packages/cli-adapters/src/github-events.js";
import type { GitHubAppInstallation } from "@jingler/core";
import WebSocket from "ws";

export interface GitHubRelayGrant {
  readonly relayUrl: string;
  readonly grant: string;
  readonly expiresAt: number;
}

export interface GitHubRelayCursorStore {
  readonly load: (clientId: string) => Promise<number>;
  readonly save: (clientId: string, cursor: number) => Promise<void>;
}

export interface GitHubRelaySocket {
  readonly readyState: number;
  addEventListener(
    type: "open" | "message" | "close" | "error",
    listener: (event: {
      readonly data?: unknown;
      readonly code?: number;
      readonly reason?: string;
    }) => void,
    options?: { once?: boolean },
  ): void;
  send(value: string): void;
  close(code?: number, reason?: string): void;
}

export interface GitHubRelaySocketRequest {
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
}

export type GitHubRelaySocketDialer = (
  request: GitHubRelaySocketRequest,
) => GitHubRelaySocket | Promise<GitHubRelaySocket>;

/** Node websocket transport; unlike the renderer API it can set Authorization. */
export const dialGitHubRelay: GitHubRelaySocketDialer = ({ url, headers }) => {
  const socket = new WebSocket(url, { headers });
  return {
    get readyState() {
      return socket.readyState;
    },
    addEventListener: (type, listener) => {
      if (type === "message") {
        socket.on("message", (data) => listener({ data: data.toString() }));
      } else if (type === "close") {
        socket.on("close", (code, reason) =>
          listener({ code, reason: reason.toString() }),
        );
      } else {
        socket.on(type, () => listener({}));
      }
    },
    send: (value) => socket.send(value),
    close: (code, reason) => socket.close(code, reason),
  };
};

export type GitHubRelayConnectionStatus =
  | { readonly mode: "connecting" | "connected" | "reconnecting" | "stopped" }
  | { readonly mode: "error"; readonly error: string };

export interface GitHubRelayConnectionOptions {
  readonly clientId: string;
  readonly grant: () => Promise<GitHubRelayGrant>;
  readonly cursorStore: GitHubRelayCursorStore;
  /**
   * Must perform the websocket HTTP upgrade with the supplied Authorization
   * header. The renderer/browser WebSocket constructor is intentionally not
   * accepted because it cannot set that header.
   */
  readonly dial: GitHubRelaySocketDialer;
  /** Return only after the delivery has been durably claimed and dispatched. */
  readonly onEvent: (event: GitHubRelayEvent, cursor: number) => Promise<void>;
  readonly onStatus?: (status: GitHubRelayConnectionStatus) => void;
  readonly heartbeatMs?: number;
  readonly pongTimeoutMs?: number;
  readonly reconnectBaseMs?: number;
  readonly reconnectMaximumMs?: number;
  readonly random?: () => number;
  readonly setTimer?: (
    callback: () => void,
    delay: number,
  ) => ReturnType<typeof setTimeout>;
  readonly clearTimer?: (timer: ReturnType<typeof setTimeout>) => void;
}

export type GitHubRelaySupervisorStatus = GitHubRelayConnectionStatus & {
  readonly sessionId: string;
  readonly relaySessionId: string;
  readonly installationId: string | null;
};

export interface GitHubRelaySessionTarget {
  /** Local session id. Never sent to the relay. */
  readonly sessionId: string;
  /** Opaque server-issued Durable Object route id. */
  readonly relaySessionId: string;
  readonly installationId: string;
}

export interface GitHubRelaySupervisorOptions {
  readonly listSessions: () => Promise<ReadonlyArray<GitHubRelaySessionTarget>>;
  readonly createConnection: (
    target: GitHubRelaySessionTarget,
    onStatus: (status: GitHubRelayConnectionStatus) => void,
  ) => GitHubRelayConnection | Promise<GitHubRelayConnection>;
  readonly onStatus?: (status: GitHubRelaySupervisorStatus) => void;
  readonly refreshMs?: number;
  readonly setTimer?: (
    callback: () => void,
    delay: number,
  ) => ReturnType<typeof setTimeout>;
  readonly clearTimer?: (timer: ReturnType<typeof setTimeout>) => void;
}

/** Whether a live installation still grants this immutable repository id. */
export const installationCanRouteRepository = (
  installations: ReadonlyArray<GitHubAppInstallation>,
  installationId: string,
  repositoryId: string,
): boolean => {
  const installation = installations.find(
    (candidate) => candidate.id === installationId,
  );
  if (!installation || installation.status !== "active") return false;
  if (installation.repositorySelection === "all") return true;
  return (installation.repositories ?? []).some(
    (repository) => repository.id === repositoryId,
  );
};

const OPEN = 1;

const relayEventsUrl = (
  relayUrl: string,
  clientId: string,
  cursor: number,
): string => {
  const url = new URL(relayUrl);
  url.protocol =
    url.protocol === "http:"
      ? "ws:"
      : url.protocol === "https:"
        ? "wss:"
        : url.protocol;
  const basePath = url.pathname.endsWith("/")
    ? url.pathname.slice(0, -1)
    : url.pathname;
  url.pathname = `${basePath}/events`;
  url.search = "";
  url.hash = "";
  url.searchParams.set("clientId", clientId);
  url.searchParams.set("cursor", String(cursor));
  return url.toString();
};

const safeError = (error: unknown): string =>
  error instanceof Error && error.message
    ? error.message
    : "GitHub relay unavailable";

/**
 * One authenticated relay stream. Integration creates one per active linked
 * session and exposes its events through the main-process RPC stream.
 */
export class GitHubRelayConnection {
  private readonly setTimer: NonNullable<
    GitHubRelayConnectionOptions["setTimer"]
  >;
  private readonly clearTimer: NonNullable<
    GitHubRelayConnectionOptions["clearTimer"]
  >;
  private socket: GitHubRelaySocket | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatTimer: ReturnType<typeof setTimeout> | null = null;
  private pongTimer: ReturnType<typeof setTimeout> | null = null;
  private attempts = 0;
  private generation = 0;
  private running = false;
  private cursor = 0;
  private processing: Promise<void> = Promise.resolve();

  constructor(private readonly options: GitHubRelayConnectionOptions) {
    this.setTimer = options.setTimer ?? setTimeout;
    this.clearTimer = options.clearTimer ?? clearTimeout;
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      this.cursor = await this.options.cursorStore.load(this.options.clientId);
    } catch (error) {
      this.options.onStatus?.({ mode: "error", error: safeError(error) });
      this.scheduleReconnect();
      return;
    }
    await this.connect(false);
  }

  stop(): void {
    this.running = false;
    this.generation += 1;
    this.clearScheduled();
    const socket = this.socket;
    this.socket = null;
    if (socket) {
      try {
        socket.close(1000, "Jingler stopped relay connection");
      } catch {
        // The transport already considers the socket closed.
      }
    }
    this.options.onStatus?.({ mode: "stopped" });
  }

  private async connect(reconnecting: boolean): Promise<void> {
    if (!this.running) return;
    const generation = ++this.generation;
    this.options.onStatus?.({
      mode: reconnecting ? "reconnecting" : "connecting",
    });
    try {
      const grant = await this.options.grant();
      if (!this.running || generation !== this.generation) return;
      const socket = await this.options.dial({
        url: relayEventsUrl(grant.relayUrl, this.options.clientId, this.cursor),
        headers: { Authorization: `Bearer ${grant.grant}` },
      });
      if (!this.running || generation !== this.generation) {
        socket.close(1000, "Superseded relay connection");
        return;
      }
      this.socket = socket;
      socket.addEventListener("open", () => {
        if (!this.current(socket, generation)) return;
        this.attempts = 0;
        this.options.onStatus?.({ mode: "connected" });
        this.scheduleHeartbeat(socket, generation);
      });
      socket.addEventListener("message", (message) => {
        if (!this.current(socket, generation)) return;
        this.handleMessage(socket, generation, message.data);
      });
      socket.addEventListener("close", () => {
        if (!this.current(socket, generation)) return;
        this.socket = null;
        this.clearHeartbeat();
        this.scheduleReconnect();
      });
      socket.addEventListener("error", () => {
        if (!this.current(socket, generation)) return;
        this.options.onStatus?.({
          mode: "error",
          error: "GitHub relay transport failed",
        });
        try {
          socket.close(1011, "Relay transport error");
        } catch {
          this.socket = null;
          this.clearHeartbeat();
          this.scheduleReconnect();
        }
      });
    } catch (error) {
      if (!this.running || generation !== this.generation) return;
      this.options.onStatus?.({ mode: "error", error: safeError(error) });
      this.scheduleReconnect();
    }
  }

  private handleMessage(
    socket: GitHubRelaySocket,
    generation: number,
    raw: unknown,
  ): void {
    const message = parseGitHubRelayServerMessage(raw);
    if (!message) {
      socket.close(1002, "Invalid relay message");
      return;
    }
    if (message.type === "pong") {
      if (this.pongTimer) this.clearTimer(this.pongTimer);
      this.pongTimer = null;
      this.scheduleHeartbeat(socket, generation);
      return;
    }
    if (message.type === "error") {
      this.options.onStatus?.({
        mode: "error",
        error: `GitHub relay: ${message.code}`,
      });
      return;
    }
    if (message.type === "hello") {
      this.processing = this.processing
        .then(async () => {
          if (message.cursor > this.cursor) {
            await this.options.cursorStore.save(
              this.options.clientId,
              message.cursor,
            );
            this.cursor = message.cursor;
          }
        })
        .catch((error: unknown) => this.failProcessing(socket, error));
      return;
    }
    if (message.type === "replay-more") {
      this.send(socket, { type: "resume", cursor: message.cursor });
      return;
    }
    if (message.type === "event-skip") {
      // A frame this client cannot decode can never be delivered, so replaying
      // it would loop forever. Advance the durable cursor past it — but loudly,
      // because a run of these means the relay and this client's event schema
      // have drifted and someone needs to reconcile them.
      console.warn(
        `[relay] skipping an undecodable event at cursor ${message.cursor}; advancing past it. A burst of these signals relay/desktop event-schema drift.`,
      );
      this.processing = this.processing
        .then(async () => {
          if (!this.current(socket, generation)) return;
          if (message.cursor <= this.cursor) {
            this.send(socket, { type: "ack", cursor: this.cursor });
            return;
          }
          await this.options.cursorStore.save(
            this.options.clientId,
            message.cursor,
          );
          this.cursor = message.cursor;
          this.send(socket, { type: "ack", cursor: message.cursor });
        })
        .catch((error: unknown) => this.failProcessing(socket, error));
      return;
    }

    this.processing = this.processing
      .then(async () => {
        if (!this.current(socket, generation)) return;
        if (message.cursor <= this.cursor) {
          this.send(socket, { type: "ack", cursor: this.cursor });
          return;
        }
        await this.options.onEvent(message.event, message.cursor);
        // Persist first: after a crash the relay's replay may repeat the frame,
        // but the local durable cursor proves the visible route already happened.
        await this.options.cursorStore.save(
          this.options.clientId,
          message.cursor,
        );
        this.cursor = message.cursor;
        this.send(socket, { type: "ack", cursor: message.cursor });
      })
      .catch((error: unknown) => this.failProcessing(socket, error));
  }

  private failProcessing(socket: GitHubRelaySocket, error: unknown): void {
    if (this.socket !== socket) return;
    this.options.onStatus?.({ mode: "error", error: safeError(error) });
    // Invalidate this socket before closing it. More frames may already be
    // queued behind the failed delivery; none may advance the durable cursor
    // until reconnect replays the failed cursor successfully.
    this.socket = null;
    this.generation += 1;
    this.clearHeartbeat();
    try {
      socket.close(1011, "Relay delivery failed");
    } catch {
      // The transport already considers the socket closed.
    }
    this.scheduleReconnect();
  }

  private send(
    socket: GitHubRelaySocket,
    message: Parameters<typeof encodeGitHubRelayClientMessage>[0],
  ): void {
    if (socket.readyState !== OPEN) return;
    socket.send(encodeGitHubRelayClientMessage(message));
  }

  private scheduleHeartbeat(
    socket: GitHubRelaySocket,
    generation: number,
  ): void {
    this.clearHeartbeat();
    const heartbeatMs = this.options.heartbeatMs ?? 20_000;
    this.heartbeatTimer = this.setTimer(() => {
      this.heartbeatTimer = null;
      if (!this.current(socket, generation)) return;
      this.send(socket, { type: "ping" });
      this.pongTimer = this.setTimer(() => {
        this.pongTimer = null;
        if (this.current(socket, generation))
          socket.close(1011, "Relay heartbeat timed out");
      }, this.options.pongTimeoutMs ?? 10_000);
    }, heartbeatMs);
  }

  private scheduleReconnect(): void {
    if (!this.running || this.retryTimer) return;
    const base = this.options.reconnectBaseMs ?? 500;
    const maximum = this.options.reconnectMaximumMs ?? 30_000;
    const exponential = Math.min(
      maximum,
      base * 2 ** Math.min(this.attempts, 10),
    );
    this.attempts += 1;
    const jitter = 0.75 + (this.options.random ?? Math.random)() * 0.5;
    this.retryTimer = this.setTimer(
      () => {
        this.retryTimer = null;
        this.connect(true).catch((error: unknown) => {
          this.options.onStatus?.({ mode: "error", error: safeError(error) });
        });
      },
      Math.round(exponential * jitter),
    );
  }

  private current(socket: GitHubRelaySocket, generation: number): boolean {
    return (
      this.running && this.socket === socket && generation === this.generation
    );
  }

  private clearHeartbeat(): void {
    if (this.heartbeatTimer) this.clearTimer(this.heartbeatTimer);
    if (this.pongTimer) this.clearTimer(this.pongTimer);
    this.heartbeatTimer = null;
    this.pongTimer = null;
  }

  private clearScheduled(): void {
    if (this.retryTimer) this.clearTimer(this.retryTimer);
    this.retryTimer = null;
    this.clearHeartbeat();
  }
}

/**
 * Keeps one independently retrying connection per active linked session and
 * periodically reconciles link, archive, suspension, and removal without an
 * app restart. The opaque relaySessionId is the connection identity: local
 * session ids never cross the relay trust boundary.
 */
export class GitHubRelaySupervisor {
  private readonly connections = new Map<
    string,
    {
      readonly target: GitHubRelaySessionTarget;
      readonly connection: GitHubRelayConnection;
    }
  >();
  private readonly setTimer: NonNullable<
    GitHubRelaySupervisorOptions["setTimer"]
  >;
  private readonly clearTimer: NonNullable<
    GitHubRelaySupervisorOptions["clearTimer"]
  >;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  private generation = 0;

  constructor(private readonly options: GitHubRelaySupervisorOptions) {
    this.setTimer = options.setTimer ?? setTimeout;
    this.clearTimer = options.clearTimer ?? clearTimeout;
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    await this.reconcile();
  }

  stop(): void {
    this.running = false;
    this.generation += 1;
    if (this.timer) this.clearTimer(this.timer);
    this.timer = null;
    for (const { target, connection } of this.connections.values()) {
      connection.stop();
      this.options.onStatus?.({ ...target, mode: "stopped" });
    }
    this.connections.clear();
  }

  private async reconcile(): Promise<void> {
    if (!this.running) return;
    const generation = ++this.generation;
    try {
      const sessions = await this.options.listSessions();
      if (!this.running || generation !== this.generation) return;
      const desired = new Map(
        sessions.map((target) => [target.relaySessionId, target]),
      );
      for (const [relaySessionId, existing] of this.connections) {
        const next = desired.get(relaySessionId);
        if (
          next &&
          next.sessionId === existing.target.sessionId &&
          next.installationId === existing.target.installationId
        ) {
          continue;
        }
        const { target, connection } = existing;
        connection.stop();
        this.connections.delete(relaySessionId);
        this.options.onStatus?.({ ...target, mode: "stopped" });
      }
      for (const target of desired.values()) {
        if (this.connections.has(target.relaySessionId)) continue;
        const connection = await this.options.createConnection(
          target,
          (status) => {
            this.options.onStatus?.({ ...target, ...status });
          },
        );
        if (!this.running || generation !== this.generation) {
          connection.stop();
          return;
        }
        this.connections.set(target.relaySessionId, { target, connection });
        await connection.start();
      }
    } catch (error) {
      if (this.running && generation === this.generation) {
        this.options.onStatus?.({
          sessionId: "",
          relaySessionId: "",
          installationId: null,
          mode: "error",
          error: safeError(error),
        });
      }
    } finally {
      if (this.running && generation === this.generation) {
        this.timer = this.setTimer(() => {
          this.timer = null;
          void this.reconcile();
        }, this.options.refreshMs ?? 10_000);
      }
    }
  }
}
