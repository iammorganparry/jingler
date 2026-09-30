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
    text(candidate.continuationAlias) &&
    text(candidate.parentRuntimeSessionId) &&
    typeof candidate.updatedAt === "number" && Number.isFinite(candidate.updatedAt)
    ? candidate as NativeSidecarOwner
    : null
}

const key = (value: Pick<NativeSidecarOwner, "sessionId" | "chatId" | "parentRuntimeSessionId">): string =>
  `${value.sessionId}\u0000${value.chatId}\u0000${value.parentRuntimeSessionId}`

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

  put(value: Omit<NativeSidecarOwner, "version" | "updatedAt">): Promise<void> {
    return this.#mutate((entries) => [
      ...entries.filter((entry) => key(entry) !== key(value)),
      {
        version: VERSION,
        sessionId: value.sessionId,
        chatId: value.chatId,
        runtimeId: value.runtimeId,
        continuationAlias: value.continuationAlias,
        parentRuntimeSessionId: value.parentRuntimeSessionId,
        updatedAt: Date.now()
      }
    ])
  }

  remove(sessionId: string, chatId: string): Promise<void> {
    return this.#mutate((entries) =>
      entries.filter((entry) => entry.sessionId !== sessionId || entry.chatId !== chatId))
  }

  #mutate(
    update: (entries: ReadonlyArray<NativeSidecarOwner>) => ReadonlyArray<NativeSidecarOwner>
  ): Promise<void> {
    const operation = this.#writes.then(async () => {
      const entries = await this.list()
      await mkdir(dirname(this.#file), { recursive: true, mode: 0o700 })
      const temporary = `${this.#file}.${process.pid}.${randomUUID()}.next`
      try {
        await writeFile(temporary, `${JSON.stringify(update(entries))}\n`, {
          mode: 0o600,
          flag: "wx"
        })
        await rename(temporary, this.#file)
      } catch (cause) {
        await rm(temporary, { force: true })
        throw cause
      }
    })
    this.#writes = operation.catch(() => undefined)
    return operation
  }
}
