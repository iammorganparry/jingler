import {
  certificationKey,
  isCurrentCertification,
  ModelCertification,
  type RuntimeContractVersions
} from "@jingler/core"
import { Schema } from "effect"
import { AtomicJsonFile } from "../persistence/atomic-json-file.js"

const CertificationDocument = Schema.Array(ModelCertification)

export interface ModelCertificationStore {
  readonly list: () => Promise<ReadonlyArray<ModelCertification>>
  readonly get: (key: string) => Promise<ModelCertification | null>
  readonly put: (certification: ModelCertification) => Promise<void>
  readonly current: (
    versions?: RuntimeContractVersions
  ) => Promise<ReadonlyArray<ModelCertification>>
}

const decodeDocument = (raw: string): ReadonlyArray<ModelCertification> =>
  Schema.decodeUnknownSync(CertificationDocument)(JSON.parse(raw))

/** Atomic, serialized persistence for non-secret certification evidence. */
export class FileModelCertificationStore implements ModelCertificationStore {
  readonly #document: AtomicJsonFile<ReadonlyArray<ModelCertification>>

  constructor(file: string) {
    this.#document = new AtomicJsonFile({ file, decode: decodeDocument, fallback: () => [] })
  }

  list = async (): Promise<ReadonlyArray<ModelCertification>> => this.#document.read()

  get = async (key: string): Promise<ModelCertification | null> =>
    (await this.#document.read()).find((item) => certificationKey(item) === key) ?? null

  put = (certification: ModelCertification): Promise<void> =>
    this.#document.update((current) => {
      const key = certificationKey(certification)
      return [
        ...current.filter((item) => certificationKey(item) !== key),
        certification
      ]
    })

  current = async (
    versions?: RuntimeContractVersions
  ): Promise<ReadonlyArray<ModelCertification>> =>
    (await this.#document.read()).filter((item) => isCurrentCertification(item, versions))

}

export class InMemoryModelCertificationStore implements ModelCertificationStore {
  #items: ReadonlyArray<ModelCertification>

  constructor(items: ReadonlyArray<ModelCertification> = []) {
    this.#items = items
  }

  list = async (): Promise<ReadonlyArray<ModelCertification>> => this.#items

  get = async (key: string): Promise<ModelCertification | null> =>
    this.#items.find((item) => certificationKey(item) === key) ?? null

  put = async (certification: ModelCertification): Promise<void> => {
    const key = certificationKey(certification)
    this.#items = [
      ...this.#items.filter((item) => certificationKey(item) !== key),
      certification
    ]
  }

  current = async (
    versions?: RuntimeContractVersions
  ): Promise<ReadonlyArray<ModelCertification>> =>
    this.#items.filter((item) => isCurrentCertification(item, versions))

}
