import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises"
import { dirname } from "node:path"
import { Schema } from "effect"
import { UsageFact, usageReportFromFacts, type UsageFact as UsageFactValue, type UsageReport as UsageReportValue } from "@jingler/core"

const FactsFile = Schema.Array(UsageFact)
const writes = new Map<string, Promise<void>>()

/** Durable cross-harness accounting; terminal facts are replaced by id. */
export class UsageFactStore {
  readonly #file: string

  constructor(file: string) {
    this.#file = file
  }

  async list(): Promise<ReadonlyArray<UsageFactValue>> {
    try {
      const raw = await readFile(this.#file, "utf8")
      return Schema.decodeUnknownSync(Schema.parseJson(FactsFile))(raw)
    } catch (cause) {
      if (cause instanceof Error && "code" in cause && cause.code === "ENOENT") return []
      throw cause
    }
  }

  record(fact: UsageFactValue): Promise<void> {
    const previous = writes.get(this.#file) ?? Promise.resolve()
    const write = previous.catch(() => undefined).then(async () => {
      const facts = [...await this.list()]
      const index = facts.findIndex(({ id }) => id === fact.id)
      if (index === -1) facts.push(fact)
      else facts[index] = fact
      await mkdir(dirname(this.#file), { recursive: true, mode: 0o700 })
      const temporary = `${this.#file}.${process.pid}.${crypto.randomUUID()}.next`
      try {
        await writeFile(temporary, `${JSON.stringify(facts)}\n`, { encoding: "utf8", mode: 0o600 })
        await rename(temporary, this.#file)
      } catch (cause) {
        await rm(temporary, { force: true })
        throw cause
      }
    })
    writes.set(this.#file, write)
    void write.finally(() => {
      if (writes.get(this.#file) === write) writes.delete(this.#file)
    }).catch(() => undefined)
    return write
  }

  async report(): Promise<UsageReportValue> {
    await writes.get(this.#file)?.catch(() => undefined)
    return usageReportFromFacts(await this.list())
  }
}
