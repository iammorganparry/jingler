import {
  findGitHubFeedbackTarget,
  githubFeedbackInstruction,
  type GitHubFeedbackTarget,
  type GitHubRelayEvent
} from "../../../../packages/cli-adapters/src/github-events.js"
import type { GitHubFeedbackClaimStatus } from "@jingler/core"
import type { ExternalInstructionIdentity } from "@jingler/core"

export interface GitHubFeedbackRouterOptions {
  readonly targets: () => ReadonlyArray<GitHubFeedbackTarget>
  /** Atomically persist the exact-session delivery claim before dispatch. */
  readonly claim: (
    target: GitHubFeedbackTarget,
    event: GitHubRelayEvent
  ) => Promise<GitHubFeedbackClaimStatus>
  readonly markDispatched: (
    target: GitHubFeedbackTarget,
    event: GitHubRelayEvent
  ) => Promise<boolean>
  /** Best-effort query invalidation for every normalized GitHub event. */
  readonly invalidate: (event: GitHubRelayEvent) => void
  /**
   * Send this through the existing conversation actor's SEND event. That actor
   * owns live steering and visible FIFO queueing when the agent is busy.
   */
  readonly dispatch: (input: {
    readonly sessionId: string
    readonly chatId: string
    readonly text: string
    readonly externalInstruction: ExternalInstructionIdentity
  }) => Promise<void>
}

export type GitHubFeedbackRouteResult =
  | { readonly status: "routed"; readonly sessionId: string }
  | {
      readonly status: "ignored"
      readonly reason: "not-actionable" | "unlinked" | "duplicate"
    }

/**
 * Deterministic renderer boundary between normalized relay frames and the
 * visible conversation actor. It holds no connection state and can therefore
 * be recreated without affecting relay replay semantics.
 */
export class GitHubFeedbackRouter {
  private serial: Promise<void> = Promise.resolve()

  constructor(private readonly options: GitHubFeedbackRouterOptions) {}

  route(
    event: GitHubRelayEvent,
    explicitTarget?: GitHubFeedbackTarget
  ): Promise<GitHubFeedbackRouteResult> {
    const operation = this.serial.then(() => this.routeSerial(event, explicitTarget))
    // Keep later deliveries ordered even when this operation fails, but return
    // the original rejection to the main process so it withholds the cursor ack.
    this.serial = operation.then(
      () => undefined,
      () => undefined
    )
    return operation
  }

  private async routeSerial(
    event: GitHubRelayEvent,
    explicitTarget?: GitHubFeedbackTarget
  ): Promise<GitHubFeedbackRouteResult> {
    this.options.invalidate(event)
    if (!(event.actionable && event.feedback)) {
      return { status: "ignored", reason: "not-actionable" }
    }
    const target = explicitTarget ?? findGitHubFeedbackTarget(event, this.options.targets())
    const instruction = githubFeedbackInstruction(event)
    if (!(target && !target.archived && instruction)) {
      return { status: "ignored", reason: "unlinked" }
    }

    const claim = await this.options.claim(target, event)
    if (claim === "dispatched") {
      return { status: "ignored", reason: "duplicate" }
    }
    if (claim === "rejected") return { status: "ignored", reason: "unlinked" }
    await this.options.dispatch({
      sessionId: target.sessionId,
      chatId: target.chatId,
      text: instruction,
      externalInstruction: {
        source: "github-feedback",
        deliveryId: event.deliveryId,
        semanticKey: event.semanticKey
      }
    })
    if (!(await this.options.markDispatched(target, event))) {
      throw new Error("GitHub feedback dispatch could not be marked durable")
    }
    return { status: "routed", sessionId: target.sessionId }
  }
}
