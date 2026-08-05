import { describe, expect, it, vi } from "vitest";
import type { GitHubRelayEvent } from "../../../../packages/cli-adapters/src/github-events.js";
import {
  GitHubRelayConnection,
  GitHubRelaySupervisor,
  installationCanRouteRepository,
  type GitHubRelaySupervisorStatus,
  type GitHubRelaySocket,
  type GitHubRelaySocketRequest,
} from "./github-relay.js";

describe("installationCanRouteRepository", () => {
  const installation = {
    id: "99",
    account: {
      id: "1",
      login: "acme",
      type: "Organization",
      avatarUrl: null,
    },
    repositorySelection: "selected" as const,
    repositories: [{ id: "200", fullName: "acme/widget" }],
    permissions: {},
    status: "active" as const,
    suspendedAt: null,
  };

  it("routes only repositories still selected on an active installation", () => {
    expect(installationCanRouteRepository([installation], "99", "200")).toBe(
      true,
    );
    expect(installationCanRouteRepository([installation], "99", "201")).toBe(
      false,
    );
    expect(
      installationCanRouteRepository(
        [{ ...installation, status: "suspended" }],
        "99",
        "200",
      ),
    ).toBe(false);
  });

  it("allows any repository id for an all-repositories installation", () => {
    expect(
      installationCanRouteRepository(
        [{ ...installation, repositorySelection: "all", repositories: [] }],
        "99",
        "any-repository-id",
      ),
    ).toBe(true);
  });
});

class FakeSocket implements GitHubRelaySocket {
  readyState = 0;
  readonly sent: string[] = [];
  readonly closes: Array<{ code?: number; reason?: string }> = [];
  private readonly listeners = new Map<
    string,
    Array<
      (event: {
        readonly data?: unknown;
        readonly code?: number;
        readonly reason?: string;
      }) => void
    >
  >();

  addEventListener(
    type: "open" | "message" | "close" | "error",
    listener: (event: {
      readonly data?: unknown;
      readonly code?: number;
      readonly reason?: string;
    }) => void,
  ): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }

  send(value: string): void {
    this.sent.push(value);
  }

  close(code?: number, reason?: string): void {
    this.closes.push({ code, reason });
    this.readyState = 3;
  }

  open(): void {
    this.readyState = 1;
    this.emit("open");
  }

  message(value: unknown): void {
    for (const listener of this.listeners.get("message") ?? []) {
      listener({ data: JSON.stringify(value) });
    }
  }

  closed(): void {
    this.readyState = 3;
    this.emit("close");
  }

  private emit(type: string): void {
    for (const listener of this.listeners.get(type) ?? []) listener({});
  }
}

const event = (): GitHubRelayEvent => ({
  version: 1,
  deliveryId: "delivery-1",
  semanticKey: "semantic-1",
  event: "pull_request_review",
  action: "submitted",
  installationId: "99",
  repository: {
    id: "200",
    owner: "acme",
    name: "widget",
    fullName: "acme/widget",
  },
  pullRequest: {
    id: "300",
    number: 42,
    title: "PR",
    url: "https://github.test/acme/widget/pull/42",
    headSha: "head",
    baseSha: "base",
  },
  actor: { id: "400", login: "reviewer", type: "User" },
  feedback: {
    kind: "review",
    id: "500",
    body: "Please change this",
    state: "changes_requested",
    path: null,
    line: null,
    side: null,
  },
  actionable: true,
  occurredAt: "2026-08-05T09:00:00.000Z",
});

const flush = async (): Promise<void> => {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
};

describe("GitHubRelayConnection", () => {
  it("authenticates, persists before acknowledging, and skips an already persisted cursor", async () => {
    const socket = new FakeSocket();
    const requests: GitHubRelaySocketRequest[] = [];
    const order: string[] = [];
    let storedCursor = 4;
    const connection = new GitHubRelayConnection({
      clientId: "desktop-1:99",
      grant: async () => ({
        relayUrl: "https://relay.jingler.test",
        grant: "short-grant",
        expiresAt: 1,
      }),
      cursorStore: {
        load: async () => storedCursor,
        save: async (_clientId, cursor) => {
          order.push(`save:${cursor}`);
          storedCursor = cursor;
        },
      },
      dial: (request) => {
        requests.push(request);
        return socket;
      },
      onEvent: async (_event, cursor) => {
        order.push(`route:${cursor}`);
      },
      heartbeatMs: 60_000,
    });
    await connection.start();
    socket.open();
    expect(requests[0]).toMatchObject({
      url: "wss://relay.jingler.test/events?clientId=desktop-1%3A99&cursor=4",
      headers: { Authorization: "Bearer short-grant" },
    });

    socket.message({ type: "event", cursor: 5, event: event() });
    await flush();
    expect(order).toEqual(["route:5", "save:5"]);
    expect(socket.sent).toContain('{"type":"ack","cursor":5}');

    socket.message({ type: "event", cursor: 5, event: event() });
    await flush();
    expect(order).toEqual(["route:5", "save:5"]);
    expect(
      socket.sent.filter((message) => message === '{"type":"ack","cursor":5}'),
    ).toHaveLength(2);
    connection.stop();
  });

  it("replays additional chunks and reconnects with the durable cursor", async () => {
    vi.useFakeTimers();
    try {
      const sockets = [new FakeSocket(), new FakeSocket()];
      const requests: GitHubRelaySocketRequest[] = [];
      let storedCursor = 0;
      let grantCalls = 0;
      const connection = new GitHubRelayConnection({
        clientId: "desktop-2:99",
        grant: async () => ({
          relayUrl: "http://127.0.0.1:9200",
          grant: `grant-${++grantCalls}`,
          expiresAt: 1,
        }),
        cursorStore: {
          load: async () => storedCursor,
          save: async (_clientId, cursor) => {
            storedCursor = cursor;
          },
        },
        dial: (request) => {
          requests.push(request);
          return sockets[requests.length - 1]!;
        },
        onEvent: async () => {},
        reconnectBaseMs: 100,
        random: () => 0.5,
        heartbeatMs: 60_000,
      });
      await connection.start();
      sockets[0]!.open();
      sockets[0]!.message({ type: "event", cursor: 1, event: event() });
      await flush();
      sockets[0]!.message({ type: "replay-more", cursor: 1 });
      expect(sockets[0]!.sent).toContain('{"type":"resume","cursor":1}');
      sockets[0]!.closed();
      await vi.advanceTimersByTimeAsync(100);
      expect(requests[1]?.url).toContain("cursor=1");
      expect(requests.map((request) => request.headers.Authorization)).toEqual([
        "Bearer grant-1",
        "Bearer grant-2",
      ]);
      expect(grantCalls).toBe(2);
      connection.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not acknowledge failed routing and closes so the relay can replay", async () => {
    const socket = new FakeSocket();
    const connection = new GitHubRelayConnection({
      clientId: "desktop-3:99",
      grant: async () => ({
        relayUrl: "https://relay.test",
        grant: "grant",
        expiresAt: 1,
      }),
      cursorStore: { load: async () => 0, save: async () => {} },
      dial: () => socket,
      onEvent: async () => {
        throw new Error("persistence failed");
      },
      heartbeatMs: 60_000,
    });
    await connection.start();
    socket.open();
    socket.message({ type: "event", cursor: 1, event: event() });
    await flush();
    expect(socket.sent).not.toContain('{"type":"ack","cursor":1}');
    expect(socket.closes).toContainEqual({
      code: 1011,
      reason: "Relay delivery failed",
    });
    connection.stop();
  });

  it("does not let a later queued frame skip past a failed delivery", async () => {
    const socket = new FakeSocket();
    const routed: number[] = [];
    const saved: number[] = [];
    const connection = new GitHubRelayConnection({
      clientId: "desktop-4:99",
      grant: async () => ({
        relayUrl: "https://relay.test",
        grant: "grant",
        expiresAt: 1,
      }),
      cursorStore: {
        load: async () => 0,
        save: async (_clientId, cursor) => {
          saved.push(cursor);
        },
      },
      dial: () => socket,
      onEvent: async (_event, cursor) => {
        routed.push(cursor);
        if (cursor === 1) throw new Error("first delivery failed");
      },
      heartbeatMs: 60_000,
      reconnectBaseMs: 60_000,
    });
    await connection.start();
    socket.open();
    socket.message({ type: "event", cursor: 1, event: event() });
    socket.message({
      type: "event",
      cursor: 2,
      event: {
        ...event(),
        deliveryId: "delivery-2",
        semanticKey: "semantic-2",
      },
    });
    await flush();
    expect(routed).toEqual([1]);
    expect(saved).toEqual([]);
    expect(socket.sent).not.toContain('{"type":"ack","cursor":2}');
    connection.stop();
  });

  it("closes and reconnects when a heartbeat pong does not arrive", async () => {
    vi.useFakeTimers();
    try {
      const socket = new FakeSocket();
      const connection = new GitHubRelayConnection({
        clientId: "desktop-5:99",
        grant: async () => ({
          relayUrl: "https://relay.test",
          grant: "grant",
          expiresAt: 1,
        }),
        cursorStore: { load: async () => 0, save: async () => {} },
        dial: () => socket,
        onEvent: async () => {},
        heartbeatMs: 100,
        pongTimeoutMs: 50,
        reconnectBaseMs: 60_000,
      });
      await connection.start();
      socket.open();
      await vi.advanceTimersByTimeAsync(100);
      expect(socket.sent).toContain('{"type":"ping"}');
      await vi.advanceTimersByTimeAsync(49);
      expect(socket.closes).toEqual([]);
      await vi.advanceTimersByTimeAsync(1);
      expect(socket.closes).toContainEqual({
        code: 1011,
        reason: "Relay heartbeat timed out",
      });
      connection.stop();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("GitHubRelaySupervisor", () => {
  it("reconciles linked session additions and removals without restart", async () => {
    vi.useFakeTimers();
    try {
      let sessions = [
        {
          sessionId: "session-a",
          relaySessionId: "relay-a",
          installationId: "99",
        },
      ];
      const sockets = new Map<string, FakeSocket>();
      const statuses: GitHubRelaySupervisorStatus[] = [];
      const supervisor = new GitHubRelaySupervisor({
        listSessions: async () => sessions,
        createConnection: (target, onStatus) => {
          const socket = new FakeSocket();
          sockets.set(target.relaySessionId, socket);
          return new GitHubRelayConnection({
            clientId: `desktop:${target.relaySessionId}`,
            grant: async () => ({
              relayUrl: "https://relay.test",
              grant: "grant",
              expiresAt: 1,
            }),
            cursorStore: { load: async () => 0, save: async () => {} },
            dial: () => socket,
            onEvent: async () => {},
            onStatus,
            heartbeatMs: 60_000,
          });
        },
        onStatus: (status) => statuses.push(status),
        refreshMs: 100,
      });

      await supervisor.start();
      sockets.get("relay-a")?.open();
      expect(statuses).toContainEqual(
        expect.objectContaining({
          sessionId: "session-a",
          relaySessionId: "relay-a",
          mode: "connected",
        }),
      );

      sessions = [
        {
          sessionId: "session-b",
          relaySessionId: "relay-b",
          installationId: "99",
        },
      ];
      await vi.advanceTimersByTimeAsync(100);
      expect(sockets.get("relay-a")?.closes).toContainEqual({
        code: 1000,
        reason: "Jingler stopped relay connection",
      });
      expect(sockets.has("relay-b")).toBe(true);
      expect(statuses).toContainEqual(
        expect.objectContaining({
          sessionId: "session-a",
          relaySessionId: "relay-a",
          mode: "stopped",
        }),
      );
      supervisor.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("retries transient setup failures and reports a recoverable error", async () => {
    vi.useFakeTimers();
    try {
      let attempts = 0;
      const statuses: GitHubRelaySupervisorStatus[] = [];
      const socket = new FakeSocket();
      const supervisor = new GitHubRelaySupervisor({
        listSessions: async () => {
          attempts += 1;
          if (attempts === 1) throw new Error("temporary status failure");
          return [
            {
              sessionId: "session-a",
              relaySessionId: "relay-a",
              installationId: "99",
            },
          ];
        },
        createConnection: (_target, onStatus) =>
          new GitHubRelayConnection({
            clientId: "desktop:99",
            grant: async () => ({
              relayUrl: "https://relay.test",
              grant: "grant",
              expiresAt: 1,
            }),
            cursorStore: { load: async () => 0, save: async () => {} },
            dial: () => socket,
            onEvent: async () => {},
            onStatus,
            heartbeatMs: 60_000,
          }),
        onStatus: (status) => statuses.push(status),
        refreshMs: 100,
      });

      await supervisor.start();
      expect(statuses).toContainEqual({
        sessionId: "",
        relaySessionId: "",
        installationId: null,
        mode: "error",
        error: "temporary status failure",
      });
      await vi.advanceTimersByTimeAsync(100);
      socket.open();
      expect(attempts).toBe(2);
      expect(statuses).toContainEqual(
        expect.objectContaining({
          sessionId: "session-a",
          relaySessionId: "relay-a",
          installationId: "99",
          mode: "connected",
        }),
      );
      supervisor.stop();
    } finally {
      vi.useRealTimers();
    }
  });
});
