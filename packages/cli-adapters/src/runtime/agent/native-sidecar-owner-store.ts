import { randomUUID } from "node:crypto"
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises"
import { dirname, resolve } from "node:path"
import type { AgentRuntimeId } from "@jingler/core"

const VERSION = 1
const MAX_FIELD_LENGTH = 4_096

export interface NativeSidecarOwner {
  readonly version: 1
  readonly sessionId: string
  readonly chatId: string
  readonly runtimeId: AgentRuntimeId
  readonly targetId: string
  readonly cwd: string
  readonly continuationAlias: string
  readonly parentRuntimeSessionId: string
  readonly updatedAt: number
}

const text = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= MAX_FIELD_LENGTH

const owner = (value: unknown): NativeSidecarOwner | null => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null
  const candidate = value as Partial<NativeSidecarOwner>
  return candidate.version === VERSION &&
    text(candidate.sessionId) &&
    text(candidate.chatId) &&
    (candidate.runtimeId === "claude" || candidate.runtimeId === "codex" || candidate.runtimeId === "opencode") &&
    text(candidate.targetId) &&
    text(candidate.cwd) &&
    text(candidate.continuationAlias) &&
    text(candidate.parentRuntimeSessionId) &&
    typeof candidate.updatedAt === "number" && Number.isFinite(candidate.updatedAt)
    ? candidate as NativeSidecarOwner
    : null
}

const key = (value: Pick<NativeSidecarOwner, "sessionId" | "chatId" | "parentRuntimeSessionId">): string =>
  `${value.sessionId}\u0000${value.chatId}\u0000${value.parentRuntimeSessionId}`

const sameOwner = (left: NativeSidecarOwner, right: NativeSidecarOwner): boolean =>
  left.version === right.version &&
  left.sessionId === right.sessionId &&
  left.chatId === right.chatId &&
  left.runtimeId === right.runtimeId &&
  left.targetId === right.targetId &&
  left.cwd === right.cwd &&
  left.continuationAlias === right.continuationAlias &&
  left.parentRuntimeSessionId === right.parentRuntimeSessionId &&
  left.updatedAt === right.updatedAt

type StoredOwner = Omit<NativeSidecarOwner, "version" | "updatedAt">

/** Atomic, secret-free ownership index for native delegation PI sidecars. */
export class NativeSidecarOwnerStore {
  readonly #file: string
  #writes: Promise<void> = Promise.resolve()

  constructor(file: string) {
    this.#file = resolve(file)
  }

  async list(): Promise<ReadonlyArray<NativeSidecarOwner>> {
    try {
      const parsed: unknown = JSON.parse(await readFile(this.#file, "utf8"))
      if (!Array.isArray(parsed)) throw new Error("Native sidecar owner index must be an array")
      const owners = parsed.map(owner)
      if (owners.some((entry) => entry === null)) {
        throw new Error("Native sidecar owner index contains an invalid entry")
      }
      return owners as ReadonlyArray<NativeSidecarOwner>
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === "ENOENT") return []
      throw cause
    }
  }

  put(value: StoredOwner): Promise<NativeSidecarOwner> {
    let persisted: NativeSidecarOwner | undefined
    return this.#mutate((entries) => {
      const previousGeneration = entries.reduce(
        (latest, entry) => Math.max(latest, entry.updatedAt),
        0
      )
      persisted = {
        version: VERSION,
        ...value,
        updatedAt: Math.max(Date.now(), previousGeneration + 1)
      }
      return [
        ...entries.filter((entry) => key(entry) !== key(value)),
        persisted
      ]
    }).then(() => persisted!)
  }

  removeExact(value: NativeSidecarOwner): Promise<void> {
    return this.#mutate((entries) => entries.filter((entry) => !sameOwner(entry, value)))
      .then(() => undefined)
  }

  /** Remove expired descriptors atomically and return only recoverable owners. */
  pruneExpired(cutoff: number): Promise<ReadonlyArray<NativeSidecarOwner>> {
    return this.#mutate((entries) => entries.filter((entry) => entry.updatedAt >= cutoff))
  }

  #mutate(
    update: (entries: ReadonlyArray<NativeSidecarOwner>) => ReadonlyArray<NativeSidecarOwner>
  ): Promise<ReadonlyArray<NativeSidecarOwner>> {
    let result: ReadonlyArray<NativeSidecarOwner> = []
    const operation = this.#writes.then(async () => {
      const entries = await this.list()
      result = update(entries)
      await mkdir(dirname(this.#file), { recursive: true, mode: 0o700 })
      const temporary = `${this.#file}.${process.pid}.${randomUUID()}.next`
      try {
        await writeFile(temporary, `${JSON.stringify(result)}\n`, {
          mode: 0o600,
          flag: "wx"
        })
        await rename(temporary, this.#file)
      } catch (cause) {
        await rm(temporary, { force: true })
        throw cause
      }
      return result
    })
    this.#writes = operation.then(() => undefined, () => undefined)
    return operation
  }
}
