import {
  createWorkspaceCheckpoint,
  restoreWorkspaceCheckpoint,
  type CheckpointManifestStore,
  type CheckpointSandbox,
  type CreateWorkspaceCheckpointInput,
  type WorkspaceCheckpointManifest
} from "./workspace-checkpoint.js"

export interface VerifiedHandoff {
  readonly verified: true
  readonly checkpoint: WorkspaceCheckpointManifest
  readonly eventCursor: number
}

/** Source remains live; callers cut over only after this verified acknowledgement. */
export const createVerifiedWorkspaceHandoff = async (
  source: CheckpointSandbox,
  target: CheckpointSandbox,
  store: CheckpointManifestStore,
  input: CreateWorkspaceCheckpointInput,
  provisionTarget: () => Promise<void>
): Promise<VerifiedHandoff> => {
  const checkpoint = await createWorkspaceCheckpoint(source, store, input)
  await provisionTarget()
  await restoreWorkspaceCheckpoint(target, store, checkpoint.manifest)
  return {
    verified: true,
    checkpoint: checkpoint.manifest,
    eventCursor: checkpoint.manifest.eventCursor
  }
}
