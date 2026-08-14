import type { RuntimeDiagnosticSnapshot } from "@jingler/core"
import { Effect, Ref } from "effect"

/** Metadata-only runtime diagnostics; prompt/tool/patch bodies never enter this service. */
export class RuntimeDiagnostics extends Effect.Service<RuntimeDiagnostics>()("@jingler/RuntimeDiagnostics", {
  accessors: true,
  effect: Effect.gen(function* () {
    const snapshots = yield* Ref.make(new Map<string, RuntimeDiagnosticSnapshot>())
    return {
      record: (snapshot: RuntimeDiagnosticSnapshot) =>
        Ref.update(snapshots, (current) => new Map(current).set(snapshot.runId, snapshot)),
      get: (runId: string) =>
        Ref.get(snapshots).pipe(Effect.map((current) => current.get(runId) ?? null)),
      latest: () =>
        Ref.get(snapshots).pipe(Effect.map((current) => [...current.values()].at(-1) ?? null)),
      export: (runId: string) =>
        Ref.get(snapshots).pipe(
          Effect.map((current) => current.get(runId) ?? null),
          Effect.map((snapshot) => JSON.stringify(snapshot, null, 2))
        )
    }
  })
}) {}
