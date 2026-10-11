import { Schema } from "effect"
import { VAULT_ORGANIZATION_HEADER } from "../auth.js"
import type { DurableObjectNamespaceLike } from "../env.js"

const VaultErrorResponse = Schema.Struct({
  error: Schema.String,
  code: Schema.optional(Schema.String),
  issueCodes: Schema.optional(Schema.Array(Schema.String))
})

export interface VaultClientFailure {
  readonly code?: string
  readonly issueCodes?: ReadonlyArray<string>
  readonly status?: number
}

export class DurableObjectVaultClient {
  constructor(
    private readonly namespace: DurableObjectNamespaceLike,
    private readonly organizationId: string,
    private readonly makeError: (message: string, failure?: VaultClientFailure) => Error
  ) {}

  async request<A, I>(
    path: string,
    schema: Schema.Schema<A, I>,
    options: {
      readonly init?: RequestInit
      readonly requestError: string
      readonly invalidResponse: string
    }
  ): Promise<A> {
    const headers = new Headers(options.init?.headers)
    headers.set(VAULT_ORGANIZATION_HEADER, this.organizationId)
    if (options.init?.body !== undefined) headers.set("content-type", "application/json")

    const id = this.namespace.idFromName(this.organizationId)
    const response = await this.namespace.get(id).fetch(
      new Request(`https://memory-vault.test${path}`, {
        ...options.init,
        headers
      })
    )
    const body: unknown = await response.json()
    if (!response.ok) {
      let detail = response.statusText
      let failure: VaultClientFailure = { status: response.status }
      try {
        const decoded = Schema.decodeUnknownSync(VaultErrorResponse)(body)
        detail = decoded.error
        failure = {
          status: response.status,
          ...(decoded.code === undefined ? {} : { code: decoded.code }),
          ...(decoded.issueCodes === undefined ? {} : { issueCodes: decoded.issueCodes })
        }
      } catch {
        // Keep the HTTP status when the peer did not return its error contract.
      }
      throw this.makeError(detail === "" ? options.requestError : `${options.requestError}: ${detail}`, failure)
    }
    try {
      return Schema.decodeUnknownSync(schema)(body)
    } catch {
      throw this.makeError(options.invalidResponse)
    }
  }
}
