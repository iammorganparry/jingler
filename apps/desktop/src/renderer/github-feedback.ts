import {
  githubFeedbackInstruction,
  type GitHubFeedbackTarget,
  type GitHubRelayEvent,
} from "../../../../packages/cli-adapters/src/github-events.js";
import type { GitHubFeedbackClaimStatus } from "@jingler/core";
import type { ExternalInstructionIdentity } from "@jingler/core";

export interface GitHubFeedbackRouterOptions {
  /** Atomically persist the exact-session delivery claim before dispatch. */
  readonly claim: (
    target: GitHubFeedbackTarget,
    event: GitHubRelayEvent,
  ) => Promise<GitHubFeedbackClaimStatus>;
  readonly markDispatched: (
    target: GitHubFeedbackTarget,
    event: GitHubRelayEvent,
  ) => Promise<boolean>;
  /** Best-effort query invalidation for every normalized GitHub event. */
  readonly invalidate: (event: GitHubRelayEvent) => void;
  /**
   * Send this through the existing conversation actor's SEND event. That actor
   * owns live steering and visible FIFO queueing when the agent is busy.
   */
  readonly dispatch: (input: {
    readonly sessionId: string;
    readonly chatId: string;
    readonly text: string;
    readonly externalInstruction: ExternalInstructionIdentity;
  }) => Promise<{ readonly accepted: Promise<void> }>;
}

export type GitHubFeedbackRouteResult =
  | {
      readonly status: "routed";
      readonly sessionId: string;
      /** Settles after the queued instruction reaches the durable transcript. */
      readonly completion: Promise<void>;
    }
  | {
      readonly status: "ignored";
      readonly reason: "not-actionable" | "unlinked" | "duplicate";
    };

/**
 * Deterministic renderer boundary between normalized relay frames and the
 * visible conversation actor. It holds no connection state and can therefore
 * be recreated without affecting relay replay semantics.
 */
export class GitHubFeedbackRouter {
  private readonly serialBySession = new Map<string, Promise<void>>();

  constructor(private readonly options: GitHubFeedbackRouterOptions) {}

  route(
    event: GitHubRelayEvent,
    target: GitHubFeedbackTarget,
  ): Promise<GitHubFeedbackRouteResult> {
    const previous = this.serialBySession.get(target.sessionId) ?? Promise.resolve();
    const operation = previous.then(() => this.routeSerial(event, target));
    // Preserve claim and UI-admission order within the owning session. Durable
    // acceptance lives on the returned completion promise, so one queued item
    // never holds later relay frames outside the UI.
    const tail = operation.then(
      () => undefined,
      () => undefined,
    );
    this.serialBySession.set(target.sessionId, tail);
    void tail.then(() => {
      if (this.serialBySession.get(target.sessionId) === tail) {
        this.serialBySession.delete(target.sessionId);
      }
    });
    return operation;
  }

  private async routeSerial(
    event: GitHubRelayEvent,
    target: GitHubFeedbackTarget,
  ): Promise<GitHubFeedbackRouteResult> {
    this.options.invalidate(event);
    if (!(event.actionable && event.feedback)) {
      return { status: "ignored", reason: "not-actionable" };
    }
    const instruction = githubFeedbackInstruction(event);
    if (!(target && !target.archived && instruction)) {
      return { status: "ignored", reason: "unlinked" };
    }

    const claim = await this.options.claim(target, event);
    if (claim === "dispatched") {
      return { status: "ignored", reason: "duplicate" };
    }
    if (claim === "rejected") return { status: "ignored", reason: "unlinked" };
    const { accepted } = await this.options.dispatch({
      sessionId: target.sessionId,
      chatId: target.chatId,
      text: instruction,
      externalInstruction: {
        source: "github-feedback",
        deliveryId: event.deliveryId,
        semanticKey: event.semanticKey,
      },
    });
    const completion = accepted.then(async () => {
      if (!(await this.options.markDispatched(target, event))) {
        throw new Error("GitHub feedback dispatch could not be marked durable");
      }
    });
    return { status: "routed", sessionId: target.sessionId, completion };
  }
}
