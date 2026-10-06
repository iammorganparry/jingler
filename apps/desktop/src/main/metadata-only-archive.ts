import { SessionStore } from "@jingler/cli-adapters"
import { GitError } from "@jingler/core"
import { Effect } from "effect"
/** Explicit operator acknowledgement archives metadata only, without touching jobs or files. */
export const archiveMetadataOnly = (id: string, reason: "merged" | "closed", acknowledged: boolean) => Effect.gen(function* () {
  const session = yield* SessionStore.get(id)
  if (!acknowledged || !session.checkpointPtyHistory) return yield* Effect.fail(new GitError({ message: "Metadata-only archive requires explicit acknowledgement of unproven terminal jobs." }))
  yield* SessionStore.archive(id, reason, true)
  return yield* SessionStore.get(id)
})
