/** Node-only runtime stand-ins; production bundles resolve the real Cloudflare module. */
export abstract class DurableObject<Environment> {
  protected constructor(
    protected readonly ctx: DurableObjectState,
    protected readonly env: Environment
  ) {}
}

export abstract class WorkflowEntrypoint<Environment, _Payload> {
  protected constructor(
    protected readonly ctx: ExecutionContext,
    protected readonly env: Environment
  ) {}
}

export class NonRetryableError extends Error {
  override readonly name: string

  constructor(message: string, name = "NonRetryableError") {
    super(message)
    this.name = name
  }
}
