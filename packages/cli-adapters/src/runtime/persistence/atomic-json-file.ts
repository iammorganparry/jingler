import { randomUUID } from "node:crypto"
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises"
import { dirname } from "node:path"

/** Serialized write-then-rename JSON persistence shared by runtime ledgers. */
export class AtomicJsonFile<Value> {
  readonly #file: string
  readonly #decode: (raw: string) => Value
  readonly #fallback: () => Value
  #queue: Promise<void> = Promise.resolve()

  constructor(input: { readonly file: string; readonly decode: (raw: string) => Value; readonly fallback: () => Value }) {
    this.#file = input.file
    this.#decode = input.decode
    this.#fallback = input.fallback
  }

  async read(): Promise<Value> {
    try {
      return this.#decode(await readFile(this.#file, "utf8"))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return this.#fallback()
      throw error
    }
  }

  write(value: Value): Promise<void> {
    return this.#serialize(() => this.#replace(value))
  }

  update(change: (current: Value) => Value | Promise<Value>): Promise<void> {
    return this.#serialize(async () => this.#replace(await change(await this.read())))
  }

  #serialize(operation: () => Promise<void>): Promise<void> {
    const next = this.#queue.then(operation, operation)
    this.#queue = next.catch(() => undefined)
    return next
  }

  async #replace(value: Value): Promise<void> {
    await mkdir(dirname(this.#file), { recursive: true })
    const temporary = `${this.#file}.${process.pid}.${randomUUID()}.tmp`
    try {
      await writeFile(temporary, JSON.stringify(value, null, 2), "utf8")
      await rename(temporary, this.#file)
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => undefined)
      throw error
    }
  }
}
