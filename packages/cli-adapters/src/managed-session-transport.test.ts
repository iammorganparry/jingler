import { once } from "node:events";
import {
  type ManagedEnvironment,
  ProviderConnectionId,
  ProviderId,
  ProviderModelId,
} from "@jingler/core";
import { Chunk, Effect, Schema, Stream } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type WebSocket, WebSocketServer } from "ws";
import { makeManagedSessionTransport } from "./managed-session-transport.js";
import type { RemoteSessionResource } from "./remote-environment-transport.js";

const servers: WebSocketServer[] = [];

afterEach(async () => {
  await Promise.all(
    servers
      .splice(0)
      .map(
        (server) =>
          new Promise<void>((resolve) => server.close(() => resolve())),
      ),
  );
});

const managedEnvironment: ManagedEnvironment = {
  kind: "managed",
  id: "managed_buildbox",
  name: "Managed buildbox",
  platform: { os: "linux", arch: "x64" },
  capabilities: {
    version: 1,
    capabilities: ["session.start", "session.observe"],
    maxConcurrentSessions: 1,
  },
  state: "online",
  agentVersion: null,
  lastSeenAt: null,
  region: "auto",
  instanceType: "basic",
  generation: 1,
  createdAt: 1,
  updatedAt: 1,
};

const managedSession = (id: string): RemoteSessionResource => ({
  id,
  environmentId: managedEnvironment.id,
  connectionId: Schema.decodeUnknownSync(ProviderConnectionId)(
    "connection_managed",
  ),
  providerId: Schema.decodeUnknownSync(ProviderId)("openai-codex"),
  modelId: Schema.decodeUnknownSync(ProviderModelId)("openai-codex:gpt-5"),
});

describe("managed session transport", () => {
  it("cancels out of band without opening an observer or command process", async () => {
    const requested: Array<{ url: string; method: string | undefined }> = [];
    const grant = vi.fn(() =>
      Effect.succeed({
        version: 1 as const,
        runtimeUrl: "https://managed-runtime.example.test",
        grant: "grant_cancel_abcdefghijklmnop",
        expiresAt: 9_999_999_999,
      }),
    );
    const transport = makeManagedSessionTransport({
      environment: () => Effect.succeed(managedEnvironment),
      grant,
      fetch: async (input, init) => {
        requested.push({ url: String(input), method: init?.method });
        return Response.json({ ok: true });
      },
    });

    const events = await Effect.runPromise(
      transport
        .execute(
          managedSession("session_cancel_abcdefgh"),
          "Agent.stop",
          { chatId: "chat_cancel" },
          "command_cancel_abcdefgh",
        )
        .pipe(Stream.runCollect),
    );

    expect(grant).toHaveBeenCalledWith(
      managedEnvironment,
      managedSession("session_cancel_abcdefgh"),
      "command_cancel_abcdefgh",
      ["session.cancel", "session.observe"],
    );
    expect(requested).toEqual([
      {
        url: "https://managed-runtime.example.test/v1/sessions/session_cancel_abcdefgh/cancel",
        method: "POST",
      },
    ]);
    expect(Chunk.toReadonlyArray(events).map((event) => event.kind)).toEqual([
      "complete",
    ]);
  });

  it("uses one command submission and the shared ordered event stream", async () => {
    const server = new WebSocketServer({ port: 0 });
    servers.push(server);
    await once(server, "listening");
    const address = server.address();
    if (address === null || typeof address === "string")
      throw new Error("missing address");
    const runtimeUrl = `http://127.0.0.1:${address.port}`;
    let observer: WebSocket | undefined;
    let authorization: string | undefined;
    server.on("connection", (socket, request) => {
      observer = socket;
      authorization = request.headers.authorization;
    });
    const submitted: unknown[] = [];
    const grant = vi.fn(() =>
      Effect.succeed({
        version: 1 as const,
        runtimeUrl,
        grant: "grant_managed_abcdefghijklmnop",
        expiresAt: 9_999_999_999,
      }),
    );
    const transport = makeManagedSessionTransport({
      environment: () => Effect.succeed(managedEnvironment),
      grant,
      fetch: async (_input, init) => {
        const command = JSON.parse(String(init?.body));
        submitted.push(command);
        observer?.send(
          JSON.stringify({
            version: 1,
            commandId: command.commandId,
            sessionId: command.sessionId,
            eventSequence: 0,
            kind: "event",
            payload: { type: "runtime.output", data: "hello" },
          }),
        );
        observer?.send(
          JSON.stringify({
            version: 1,
            commandId: command.commandId,
            sessionId: command.sessionId,
            eventSequence: 1,
            kind: "complete",
            payload: { exitCode: 0 },
          }),
        );
        return Response.json({ accepted: true }, { status: 202 });
      },
    });
    const events = await Effect.runPromise(
      transport
        .execute(
          managedSession("session_managed_abcdefgh"),
          "ManagedRuntime.exec",
          { command: "printf hello" },
          "command_managed_abcdefgh",
        )
        .pipe(Stream.runCollect),
    );

    expect(authorization).toBe("Bearer grant_managed_abcdefghijklmnop");
    expect(grant).toHaveBeenCalledWith(
      managedEnvironment,
      managedSession("session_managed_abcdefgh"),
      "command_managed_abcdefgh",
      ["session.input", "session.observe"],
    );
    expect(submitted).toHaveLength(1);
    expect(Chunk.toReadonlyArray(events).map((event) => event.kind)).toEqual([
      "event",
      "complete",
    ]);
  });

  it("re-grants and resumes after a transient observer disconnect", async () => {
    const server = new WebSocketServer({ port: 0 });
    servers.push(server);
    await once(server, "listening");
    const address = server.address();
    if (address === null || typeof address === "string")
      throw new Error("missing address");
    const runtimeUrl = `http://127.0.0.1:${address.port}`;
    const observers: WebSocket[] = [];
    const replayCursors: string[] = [];
    server.on("connection", (socket, request) => {
      observers.push(socket);
      replayCursors.push(
        new URL(request.url ?? "/", runtimeUrl).searchParams.get("after") ?? "",
      );
      if (observers.length === 2) {
        socket.send(
          JSON.stringify({
            version: 1,
            commandId: "command_reconnect_abcdefgh",
            sessionId: "session_reconnect_abcdefgh",
            eventSequence: 1,
            kind: "complete",
            payload: { exitCode: 0 },
          }),
        );
      }
    });
    const grant = vi.fn(() =>
      Effect.succeed({
        version: 1 as const,
        runtimeUrl,
        grant: "grant_reconnect_abcdefghijkl",
        expiresAt: 9_999_999_999,
      }),
    );
    let submissions = 0;
    const transport = makeManagedSessionTransport({
      environment: () => Effect.succeed(managedEnvironment),
      grant,
      fetch: async () => {
        submissions += 1;
        observers[0]?.send(
          JSON.stringify({
            version: 1,
            commandId: "command_reconnect_abcdefgh",
            sessionId: "session_reconnect_abcdefgh",
            eventSequence: 0,
            kind: "event",
            payload: { type: "runtime.output", data: "before disconnect" },
          }),
        );
        observers[0]?.close(1012, "restart");
        return Response.json({ accepted: true }, { status: 202 });
      },
    });

    const events = await Effect.runPromise(
      transport
        .execute(
          managedSession("session_reconnect_abcdefgh"),
          "ManagedRuntime.exec",
          { command: "printf hello" },
          "command_reconnect_abcdefgh",
        )
        .pipe(Stream.runCollect),
    );

    expect(submissions).toBe(1);
    expect(grant).toHaveBeenCalledTimes(2);
    expect(replayCursors).toEqual(["-1", "0"]);
    expect(Chunk.toReadonlyArray(events).map((event) => event.kind)).toEqual([
      "event",
      "complete",
    ]);
  });

  it("reconnects and durably replays when an open observer silently misses completion", async () => {
    const server = new WebSocketServer({ port: 0 });
    servers.push(server);
    await once(server, "listening");
    const address = server.address();
    if (address === null || typeof address === "string")
      throw new Error("missing address");
    const runtimeUrl = `http://127.0.0.1:${address.port}`;
    let observers = 0;
    server.on("connection", (socket) => {
      observers += 1;
      if (observers === 2) {
        socket.send(
          JSON.stringify({
            version: 1,
            commandId: "command_idle_replay_abcdef",
            sessionId: "session_idle_replay_abcdef",
            eventSequence: 0,
            kind: "complete",
            payload: { status: "ready" },
          }),
        );
      }
    });
    const grant = vi.fn(() =>
      Effect.succeed({
        version: 1 as const,
        runtimeUrl,
        grant: "grant_idle_replay_abcdefghijkl",
        expiresAt: 9_999_999_999,
      }),
    );
    const transport = makeManagedSessionTransport({
      environment: () => Effect.succeed(managedEnvironment),
      grant,
      observerIdleMs: 10,
      fetch: async () => Response.json({ accepted: true }, { status: 202 }),
    });

    const events = await Effect.runPromise(
      transport
        .execute(
          managedSession("session_idle_replay_abcdef"),
          "Sessions.diff",
          {},
          "command_idle_replay_abcdef",
        )
        .pipe(Stream.runCollect),
    );

    expect(observers).toBe(2);
    expect(grant).toHaveBeenCalledTimes(2);
    expect(Chunk.toReadonlyArray(events).map((event) => event.kind)).toEqual([
      "complete",
    ]);
  });
});
