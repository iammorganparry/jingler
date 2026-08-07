import type { PublishCheckpoint, PublishMetadata, PublishStep } from "@jingler/core"
import { assign, createActor, fromPromise, setup, type SnapshotFrom } from "xstate"
import { isPublishMetadataSafe } from "./publish-metadata.js"

export interface PublishInspection {
  readonly branch: string | null
  readonly hasChanges: boolean
  readonly unpublished: number
  readonly changedPaths: ReadonlyArray<string>
  readonly diffSummary: string
  readonly headSha: string | null
}

export interface PublishOperations {
  readonly inspect: () => Promise<PublishInspection>
  readonly verifyBranch: (inspection: PublishInspection) => Promise<string>
  readonly generateMetadata: (inspection: PublishInspection) => Promise<PublishMetadata>
  readonly stage: () => Promise<void>
  readonly commit: (message: string) => Promise<string>
  readonly authenticate: () => Promise<void>
  readonly push: (branch: string) => Promise<void>
  readonly resolvePr: (branch: string) => Promise<number | null>
  readonly createPr: (metadata: PublishMetadata) => Promise<number>
  readonly updatePr: (number: number, metadata: PublishMetadata) => Promise<void>
  readonly link: (number: number) => Promise<void>
}

interface PublishContext {
  inspection: PublishInspection | null
  metadata: PublishMetadata | null
  commitSha: string | null
  prNumber: number | null
  completed: ReadonlyArray<PublishStep>
  error: string | null
  resumeFrom: PublishStep | null
}

type PublishEvent = { type: "RETRY" }

const message = (error: unknown): string =>
  error instanceof Error ? error.message : "Publishing failed."

const resumable = (checkpoint: PublishCheckpoint | undefined): boolean =>
  checkpoint?.step === "failed"

export const createPublishMachine = (
  checkpoint: PublishCheckpoint | undefined,
  operations: PublishOperations
) => setup({
  types: {
    context: {} as PublishContext,
    events: {} as PublishEvent
  },
  actors: {
    inspect: fromPromise(() => operations.inspect()),
    verifyBranch: fromPromise(({ input }: { input: PublishInspection }) => operations.verifyBranch(input)),
    metadata: fromPromise(({ input }: { input: PublishInspection }) => operations.generateMetadata(input)),
    stage: fromPromise(() => operations.stage()),
    commit: fromPromise(({ input }: { input: PublishMetadata }) => operations.commit(input.commitMessage)),
    authenticate: fromPromise(() => operations.authenticate()),
    push: fromPromise(({ input }: { input: string }) => operations.push(input)),
    resolvePr: fromPromise(({ input }: { input: string }) => operations.resolvePr(input)),
    createPr: fromPromise(({ input }: { input: PublishMetadata }) => operations.createPr(input)),
    updatePr: fromPromise(({ input }: { input: { number: number; metadata: PublishMetadata } }) => operations.updatePr(input.number, input.metadata)),
    link: fromPromise(({ input }: { input: number }) => operations.link(input))
  },
  guards: {
    nothingToPublish: ({ context }) => context.inspection !== null && !context.inspection.hasChanges && context.inspection.unpublished === 0,
    needsCommit: ({ context }) => context.inspection?.hasChanges === true,
    hasMetadata: ({ context }) => context.metadata !== null,
    hasPr: ({ context }) => context.prNumber !== null
  },
  actions: {
    markCompleted: assign({
      completed: ({ context }, params: { step: PublishStep }) =>
        context.completed.includes(params.step)
          ? context.completed
          : [...context.completed, params.step]
    })
  }
}).createMachine({
  id: "publish",
  initial: "inspecting",
  context: {
    inspection: null,
    metadata:
      resumable(checkpoint) && checkpoint?.metadata && isPublishMetadataSafe(checkpoint.metadata)
        ? checkpoint.metadata
        : null,
    commitSha: resumable(checkpoint) ? checkpoint?.commitSha ?? null : null,
    prNumber: resumable(checkpoint) ? checkpoint?.prNumber ?? null : null,
    completed: resumable(checkpoint) ? checkpoint?.completed ?? [] : [],
    error: null,
    resumeFrom: null
  },
  states: {
    inspecting: {
      invoke: {
        src: "inspect",
        onDone: {
          target: "verifying-branch",
          actions: [
            assign({ inspection: ({ event }) => event.output }),
            { type: "markCompleted", params: { step: "inspecting" } }
          ]
        },
        onError: { target: "failed", actions: assign({ error: ({ event }) => message(event.error), resumeFrom: () => "inspecting" as const }) }
      }
    },
    "verifying-branch": {
      invoke: {
        src: "verifyBranch",
        input: ({ context }) => context.inspection!,
        onDone: {
          target: "inspectionReady",
          actions: [
            assign({
              inspection: ({ context, event }) => ({ ...context.inspection!, branch: event.output }),
              commitSha: ({ context }) =>
                context.commitSha ??
                (!context.inspection!.hasChanges && context.inspection!.unpublished > 0
                  ? context.inspection!.headSha
                  : null)
            }),
            { type: "markCompleted", params: { step: "verifying-branch" } }
          ]
        },
        onError: { target: "failed", actions: assign({ error: ({ event }) => message(event.error), resumeFrom: () => "verifying-branch" as const }) }
      }
    },
    inspectionReady: {
      always: [
        { guard: "nothingToPublish", target: "no-changes" },
        { guard: "hasMetadata", target: "metadataReady" },
        { target: "generating-metadata" }
      ]
    },
    "generating-metadata": {
      invoke: {
        src: "metadata",
        input: ({ context }) => context.inspection!,
        onDone: {
          target: "metadataReady",
          actions: [
            assign({ metadata: ({ event }) => event.output }),
            { type: "markCompleted", params: { step: "generating-metadata" } }
          ]
        },
        onError: { target: "failed", actions: assign({ error: ({ event }) => message(event.error), resumeFrom: () => "generating-metadata" as const }) }
      }
    },
    metadataReady: { always: [{ guard: "needsCommit", target: "staging" }, { target: "authenticating" }] },
    staging: {
      invoke: {
        src: "stage",
        onDone: {
          target: "committing",
          actions: { type: "markCompleted", params: { step: "staging" } }
        },
        onError: {
          target: "failed",
          actions: assign({
            error: ({ event }) => message(event.error),
            resumeFrom: () => "staging" as const
          })
        }
      }
    },
    committing: {
      invoke: {
        src: "commit", input: ({ context }) => context.metadata!,
        onDone: {
          target: "authenticating",
          actions: [
            assign({ commitSha: ({ event }) => event.output }),
            { type: "markCompleted", params: { step: "committing" } }
          ]
        },
        onError: { target: "failed", actions: assign({ error: ({ event }) => message(event.error), resumeFrom: () => "committing" as const }) }
      }
    },
    authenticating: {
      invoke: {
        src: "authenticate",
        onDone: {
          target: "pushing",
          actions: { type: "markCompleted", params: { step: "authenticating" } }
        },
        onError: {
          target: "failed",
          actions: assign({
            error: ({ event }) => message(event.error),
            resumeFrom: () => "authenticating" as const
          })
        }
      }
    },
    pushing: {
      invoke: {
        src: "push",
        input: ({ context }) => context.inspection!.branch!,
        onDone: {
          target: "checking-pr",
          actions: { type: "markCompleted", params: { step: "pushing" } }
        },
        onError: {
          target: "failed",
          actions: assign({
            error: ({ event }) => message(event.error),
            resumeFrom: () => "pushing" as const
          })
        }
      }
    },
    "checking-pr": {
      always: [
        { guard: "hasPr", target: "linking" },
        { target: "resolving-pr" }
      ]
    },
    "resolving-pr": {
      invoke: {
        src: "resolvePr", input: ({ context }) => context.inspection!.branch!,
        onDone: {
          target: "prResolved",
          actions: [
            assign({ prNumber: ({ context, event }) => context.prNumber ?? event.output }),
            { type: "markCompleted", params: { step: "resolving-pr" } }
          ]
        },
        onError: { target: "failed", actions: assign({ error: ({ event }) => message(event.error), resumeFrom: () => "resolving-pr" as const }) }
      }
    },
    prResolved: { always: [{ guard: "hasPr", target: "linking" }, { target: "creating-pr" }] },
    "creating-pr": {
      invoke: {
        src: "createPr", input: ({ context }) => context.metadata!,
        onDone: {
          target: "linking",
          actions: [
            assign({ prNumber: ({ event }) => event.output }),
            { type: "markCompleted", params: { step: "creating-pr" } }
          ]
        },
        onError: { target: "failed", actions: assign({ error: ({ event }) => message(event.error), resumeFrom: () => "creating-pr" as const }) }
      }
    },
    "updating-pr": {
      invoke: {
        src: "updatePr",
        input: ({ context }) => ({ number: context.prNumber!, metadata: context.metadata! }),
        onDone: {
          target: "complete",
          actions: { type: "markCompleted", params: { step: "updating-pr" } }
        },
        onError: {
          target: "failed",
          actions: assign({
            error: ({ event }) => message(event.error),
            resumeFrom: () => "updating-pr" as const
          })
        }
      }
    },
    linking: {
      invoke: {
        src: "link",
        input: ({ context }) => context.prNumber!,
        onDone: {
          target: "updating-pr",
          actions: { type: "markCompleted", params: { step: "linking" } }
        },
        onError: {
          target: "failed",
          actions: assign({
            error: ({ event }) => message(event.error),
            resumeFrom: () => "linking" as const
          })
        }
      }
    },
    complete: { type: "final" },
    "no-changes": { type: "final" },
    failed: { on: { RETRY: { target: "inspecting", actions: assign({ error: null, resumeFrom: null }) } } }
  }
})

const visibleStep = (value: string): PublishStep => {
  if (value === "inspectionReady") return "verifying-branch"
  if (value === "metadataReady") return "generating-metadata"
  if (value === "checking-pr") return "pushing"
  if (value === "prResolved") return "resolving-pr"
  return value as PublishStep
}

const checkpointFor = (snapshot: SnapshotFrom<ReturnType<typeof createPublishMachine>>): PublishCheckpoint => {
  const state = visibleStep(String(snapshot.value))
  return {
    step: state,
    completed: [...snapshot.context.completed],
    ...(snapshot.context.metadata ? { metadata: snapshot.context.metadata } : {}),
    ...(snapshot.context.inspection?.branch ? { branch: snapshot.context.inspection.branch } : {}),
    ...(snapshot.context.commitSha ? { commitSha: snapshot.context.commitSha } : {}),
    ...(snapshot.context.prNumber !== null ? { prNumber: snapshot.context.prNumber } : {}),
    ...(snapshot.context.error ? { error: snapshot.context.error } : {}),
    ...(snapshot.context.resumeFrom ? { resumeFrom: snapshot.context.resumeFrom } : {}),
    updatedAt: new Date().toISOString()
  }
}

export const runPublishMachine = async (
  checkpoint: PublishCheckpoint | undefined,
  operations: PublishOperations,
  persist: (checkpoint: PublishCheckpoint) => Promise<void>,
  onCheckpoint?: (checkpoint: PublishCheckpoint) => void
): Promise<PublishCheckpoint> => {
  const actor = createActor(createPublishMachine(checkpoint, operations))
  let writes = Promise.resolve()
  let persistError: unknown = null
  let latest: PublishCheckpoint | null = null
  const result = new Promise<PublishCheckpoint>((resolve, reject) => {
    actor.subscribe((snapshot) => {
      const next = checkpointFor(snapshot as never)
      latest = next
      onCheckpoint?.(next)
      writes = writes
        .then(() => persist(next))
        .catch((error: unknown) => {
          persistError ??= error
        })
      if (snapshot.status === "done" || snapshot.matches("failed")) {
        void writes.then(() => {
          if (persistError !== null) reject(persistError)
          else resolve(latest!)
        })
      }
    })
  })
  actor.start()
  return result
}

const activePublishes = new Map<string, Promise<PublishCheckpoint>>()

/**
 * Main-process single-flight boundary for publish button races. A duplicate
 * request observes the authoritative run's final checkpoint instead of
 * starting a second commit/push/PR mutation sequence.
 */
export const runPublishMachineExclusive = (
  key: string,
  checkpoint: PublishCheckpoint | undefined,
  operations: PublishOperations,
  persist: (checkpoint: PublishCheckpoint) => Promise<void>,
  onCheckpoint?: (checkpoint: PublishCheckpoint) => void
): Promise<PublishCheckpoint> => {
  const active = activePublishes.get(key)
  if (active) return active.then((result) => {
    onCheckpoint?.(result)
    return result
  })
  const run = runPublishMachine(checkpoint, operations, persist, onCheckpoint)
  activePublishes.set(key, run)
  void run.finally(() => {
    if (activePublishes.get(key) === run) activePublishes.delete(key)
  }).catch(() => {})
  return run
}
