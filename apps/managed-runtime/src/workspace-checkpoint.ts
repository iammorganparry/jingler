export const WORKSPACE_BACKUP_EXCLUDES = [
  "node_modules",
  "*/node_modules",
  "**/node_modules",
  ".pnpm-store",
  "**/.pnpm-store",
  ".yarn/cache",
  "**/.yarn/cache",
  ".npm",
  "**/.npm",
  "dist",
  "**/dist",
  "build",
  "**/build",
  "out",
  "**/out",
  ".next",
  "**/.next",
  ".turbo",
  "**/.turbo",
  ".cache",
  "**/.cache",
  "coverage",
  "**/coverage",
  "*.log",
  "**/*.log"
] as const

export interface WorkspaceArchive {
  readonly id: string
  readonly key: string
  readonly format: "tar-gzip"
  readonly size: number
  readonly expiresAt: number
}

export interface WorkspaceCheckpointManifest {
  readonly version: 1
  readonly checkpointId: string
  readonly subject: string
  readonly environmentId: string
  readonly sessionId: string
  readonly workspaceDigest: string
  readonly headSha: string
  readonly branch: string
  readonly staged: boolean
  readonly dirty: boolean
  readonly eventCursor: number
  readonly backup: WorkspaceArchive
  readonly createdAt: number
  readonly estimatedBytes: number
}

export interface CheckpointSandbox {
  readonly exec: (
    command: string,
    options: { readonly cwd: string; readonly timeout: number }
  ) => Promise<{ readonly success: boolean; readonly stdout: string; readonly stderr: string }>
  readonly readFile: (
    path: string,
    options: { readonly encoding: "none" }
  ) => Promise<{
    readonly success: true
    readonly content: ReadableStream<Uint8Array>
    readonly size: number
  }>
  readonly writeFile: (
    path: string,
    content: ReadableStream<Uint8Array>
  ) => Promise<{ readonly success: boolean }>
  readonly deleteFile: (path: string) => Promise<unknown>
}

export interface CheckpointManifestStore {
  readonly put: (
    key: string,
    value: string | ReadableStream<Uint8Array>,
    size?: number
  ) => Promise<void>
  readonly get: (key: string) => Promise<ReadableStream<Uint8Array> | null>
}

export interface CreateWorkspaceCheckpointInput {
  readonly checkpointId: string
  readonly subject: string
  readonly environmentId: string
  readonly sessionId: string
  readonly previousCheckpoint: WorkspaceCheckpointManifest | null
  readonly eventCursor: number
  readonly nowSeconds: number
  readonly retentionSeconds: number
  readonly maxBytes?: number
}

const DIGEST_COMMAND =
  "{ git diff --binary HEAD -- .; git ls-files --others --exclude-standard -z | sort -z | xargs -0 -r sha256sum; } | sha256sum | cut -d' ' -f1"

const IDENTITY_COMMAND =
  'git rev-parse HEAD && git branch --show-current && if git diff --cached --quiet -- .; then echo 0; else echo 1; fi && if test -z "$(git status --porcelain=v1 --untracked-files=normal)"; then echo 0; else echo 1; fi'

const SIZE_COMMAND =
  "find . -type d \\( -name node_modules -o -name .pnpm-store -o -name dist -o -name build -o -name out -o -name .next -o -name .turbo -o -name .cache -o -name coverage \\) -prune -o -type f -printf '%s\\n' | awk '{ total += $1 } END { print total + 0 }'"

const manifestKey = (input: CreateWorkspaceCheckpointInput): string =>
  `manifests/${encodeURIComponent(input.subject)}/${encodeURIComponent(input.sessionId)}/${encodeURIComponent(input.checkpointId)}.json`

const archiveKey = (input: CreateWorkspaceCheckpointInput): string =>
  `archives/${encodeURIComponent(input.subject)}/${encodeURIComponent(input.sessionId)}/${encodeURIComponent(input.checkpointId)}.tar.gz`

const archivePath = (checkpointId: string): string => {
  if (!/^[a-zA-Z0-9_-]{1,128}$/u.test(checkpointId)) {
    throw new Error("Invalid workspace checkpoint identifier")
  }
  return `/tmp/jingler-${checkpointId}.tar.gz`
}

const TAR_EXCLUDES = WORKSPACE_BACKUP_EXCLUDES.map((pattern) =>
  `--exclude=${JSON.stringify(pattern)}`
).join(" ")

export const createWorkspaceCheckpoint = async (
  sandbox: CheckpointSandbox,
  store: CheckpointManifestStore,
  input: CreateWorkspaceCheckpointInput
): Promise<
  | {
      readonly status: "skipped"
      readonly workspaceDigest: string
      readonly manifest: WorkspaceCheckpointManifest
    }
  | {
      readonly status: "created"
      readonly workspaceDigest: string
      readonly manifest: WorkspaceCheckpointManifest
    }
> => {
  const digestResult = await sandbox.exec(DIGEST_COMMAND, {
    cwd: "/workspace",
    timeout: 120_000
  })
  const workspaceDigest = digestResult.stdout.trim().toLowerCase()
  if (!(digestResult.success && /^[a-f0-9]{64}$/u.test(workspaceDigest))) {
    throw new Error("Unable to calculate a bounded workspace digest")
  }
  const renewalWindowSeconds = Math.max(
    60,
    Math.min(24 * 60 * 60, Math.floor(input.retentionSeconds / 4))
  )
  if (
    input.previousCheckpoint?.workspaceDigest === workspaceDigest &&
    input.previousCheckpoint.backup.expiresAt >
      input.nowSeconds + renewalWindowSeconds
  ) {
    return {
      status: "skipped",
      workspaceDigest,
      manifest: {
        ...input.previousCheckpoint,
        eventCursor: input.eventCursor
      }
    }
  }
  const [identityResult, sizeResult] = await Promise.all([
    sandbox.exec(IDENTITY_COMMAND, { cwd: "/workspace", timeout: 30_000 }),
    sandbox.exec(SIZE_COMMAND, { cwd: "/workspace", timeout: 30_000 })
  ])
  const estimatedBytes = Number(sizeResult.stdout.trim())
  if (
    !(sizeResult.success &&Number.isSafeInteger(estimatedBytes) ) ||
    estimatedBytes < 0 ||
    estimatedBytes > (input.maxBytes ?? 64 * 1024 * 1024)
  ) {
    throw new Error("Workspace checkpoint exceeds its configured size limit")
  }
  const [headSha, branch, stagedFlag, dirtyFlag] = identityResult.stdout
    .trim()
    .split("\n")
  if (
    !(((identityResult.success &&headSha ) &&/^[a-f0-9]{40,64}$/iu.test(headSha) ) &&branch ) ||
    (stagedFlag !== "0" && stagedFlag !== "1") ||
    (dirtyFlag !== "0" && dirtyFlag !== "1")
  ) {
    throw new Error("Unable to capture checkpoint Git identity")
  }
  const path = archivePath(input.checkpointId)
  const packed = await sandbox.exec(
    `tar --create --gzip --file=${JSON.stringify(path)} --exclude-vcs-ignores ${TAR_EXCLUDES} --directory=/workspace .`,
    { cwd: "/workspace", timeout: 120_000 }
  )
  if (!packed.success) {
    throw new Error("Unable to create workspace checkpoint archive")
  }
  const archive = await sandbox.readFile(path, { encoding: "none" })
  const archiveSize = archive.size
  if (
    !Number.isSafeInteger(archiveSize) ||
    archiveSize < 0 ||
    archiveSize > (input.maxBytes ?? 64 * 1024 * 1024)
  ) {
    await sandbox.deleteFile(path).catch(() => undefined)
    throw new Error("Workspace checkpoint archive exceeds its configured size limit")
  }
  const key = archiveKey(input)
  try {
    await store.put(key, archive.content, archiveSize)
  } finally {
    await sandbox.deleteFile(path).catch(() => undefined)
  }
  const backup: WorkspaceArchive = {
    id: input.checkpointId,
    key,
    format: "tar-gzip",
    size: archiveSize,
    expiresAt: input.nowSeconds + input.retentionSeconds
  }
  const manifest: WorkspaceCheckpointManifest = {
    version: 1,
    checkpointId: input.checkpointId,
    subject: input.subject,
    environmentId: input.environmentId,
    sessionId: input.sessionId,
    workspaceDigest,
    headSha,
    branch,
    staged: stagedFlag === "1",
    dirty: dirtyFlag === "1",
    eventCursor: input.eventCursor,
    backup,
    createdAt: input.nowSeconds,
    estimatedBytes
  }
  await store.put(manifestKey(input), JSON.stringify(manifest))
  return { status: "created", workspaceDigest, manifest }
}

export const restoreWorkspaceCheckpoint = async (
  sandbox: CheckpointSandbox,
  store: CheckpointManifestStore,
  manifest: WorkspaceCheckpointManifest
): Promise<void> => {
  const archive = await store.get(manifest.backup.key)
  if (archive === null) {
    throw new Error("Workspace checkpoint restore failed")
  }
  const path = archivePath(manifest.backup.id)
  const written = await sandbox.writeFile(path, archive)
  if (!written.success) throw new Error("Workspace checkpoint restore failed")
  try {
    const restored = await sandbox.exec(
      `tar --extract --gzip --file=${JSON.stringify(path)} --directory=/workspace`,
      { cwd: "/workspace", timeout: 120_000 }
    )
    if (!restored.success) throw new Error("Workspace checkpoint restore failed")
  } finally {
    await sandbox.deleteFile(path).catch(() => undefined)
  }
  const [digestResult, identityResult] = await Promise.all([
    sandbox.exec(DIGEST_COMMAND, { cwd: "/workspace", timeout: 120_000 }),
    sandbox.exec(IDENTITY_COMMAND, { cwd: "/workspace", timeout: 30_000 })
  ])
  const [headSha, branch, stagedFlag, dirtyFlag] = identityResult.stdout
    .trim()
    .split("\n")
  if (
    !digestResult.success ||
    digestResult.stdout.trim().toLowerCase() !== manifest.workspaceDigest ||
    !identityResult.success ||
    headSha?.toLowerCase() !== manifest.headSha.toLowerCase() ||
    branch !== manifest.branch ||
    (stagedFlag === "1") !== manifest.staged ||
    (dirtyFlag === "1") !== manifest.dirty
  ) {
    throw new Error("Restored workspace identity does not match its checkpoint")
  }
}
