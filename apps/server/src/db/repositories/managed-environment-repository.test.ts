import type { ManagedEnvironment } from "@jingler/core";
import { Effect, Layer } from "effect";
import { describe, expect, it } from "vitest";
import { Database } from "../database.js";
import {
  MANAGED_ENVIRONMENT_LIST_LIMIT,
  ManagedEnvironmentRepository,
} from "./managed-environment-repository.js";

const row = {
  id: "managed_one",
  userId: "user_one",
  displayName: "Cloud workspace",
  state: "paused",
  region: "wnam",
  instanceType: "basic",
  capabilities: JSON.stringify({
    version: 1,
    capabilities: ["session.start"],
    maxConcurrentSessions: 1,
  }),
  generation: 1,
  createdAt: new Date("2026-08-10T12:00:00.000Z"),
  updatedAt: new Date("2026-08-10T12:00:00.000Z"),
};

const runWith = <A>(
  results: Readonly<Record<string, unknown>>,
  effect: Effect.Effect<A, unknown, ManagedEnvironmentRepository>,
): Promise<A> => {
  const database = Layer.succeed(Database, {
    run: (operation: string) => Effect.succeed(results[operation]),
  } as unknown as Database);
  return Effect.runPromise(
    effect.pipe(
      Effect.provide(ManagedEnvironmentRepository.Default),
      Effect.provide(database),
    ),
  );
};

describe("ManagedEnvironmentRepository", () => {
  it("reuses an environment for the same user idempotency key", async () => {
    const environment = await runWith(
      { "ManagedEnvironmentRepository.create": [row] },
      ManagedEnvironmentRepository.create({
        id: "managed_new",
        userId: "user_one",
        displayName: "Cloud workspace",
        region: "wnam",
        instanceType: "basic",
        capabilities: JSON.parse(row.capabilities),
        idempotencyKey: "create_one",
        at: row.createdAt,
      }),
    );

    expect(environment.id).toBe(row.id);
    expect(environment.kind).toBe("managed");
  });

  it("cannot read another user's managed environment", async () => {
    const environment = await runWith(
      { "ManagedEnvironmentRepository.findForUser": [] },
      ManagedEnvironmentRepository.findForUser("user_two", row.id),
    );

    expect(environment).toBeNull();
  });

  it("uses bounded inventory projections and deterministic ordering", async () => {
    const environments = await runWith(
      {
        "ManagedEnvironmentRepository.listForUser": [
          row,
          {
            ...row,
            id: "managed_two",
            createdAt: new Date(row.createdAt.getTime() + 1),
          },
        ],
      },
      ManagedEnvironmentRepository.listForUser("user_one"),
    );

    expect(MANAGED_ENVIRONMENT_LIST_LIMIT).toBe(128);
    expect(
      environments.map((environment: ManagedEnvironment) => environment.id),
    ).toEqual(["managed_one", "managed_two"]);
    expect(JSON.stringify(environments)).not.toMatch(
      /idempotency|secret|grant|token/i,
    );
  });
});
