/**
 * Native plan review — Jingler's fork replaces the upstream loopback HTTP
 * server + browser SPA with a review session decided over the pi event bus.
 *
 * The extension publishes `review: { reviewId }` on the host-state channel;
 * the host renders its own review surface and emits the operator's verdict on
 * PLANNOTATOR_REVIEW_DECISION_CHANNEL. The first decision whose reviewId
 * matches settles the session; everything else (stale ids, duplicates) is
 * ignored. Abort settles with the same stopped-error name the upstream
 * browser session used, so caller error handling is unchanged.
 */
import { randomUUID } from "node:crypto";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { BROWSER_SESSION_STOPPED } from "./browser-session-error.ts";

export const PLANNOTATOR_REVIEW_DECISION_CHANNEL = "plannotator:review-decision" as const;
export const PLANNOTATOR_REVIEW_DECISION_ACK_CHANNEL = "plannotator:review-decision-ack" as const;

/** Convert a startup failure into the stable user-facing message used by Pi commands and events. */
export function getStartupErrorMessage(error: unknown): string {
	return error instanceof Error ? error.message : "Unknown error";
}

export interface PlanReviewDecision {
	approved: boolean;
	feedback?: string;
	savedPath?: string;
	agentSwitch?: string;
	permissionMode?: string;
}

export interface PlannotatorReviewDecisionEvent extends PlanReviewDecision {
	reviewId: string;
}

export interface NativePlanReviewSession {
	reviewId: string;
	waitForDecision: () => Promise<PlanReviewDecision>;
	onDecision: (listener: (result: PlanReviewDecision) => void | Promise<void>) => () => void;
	stop: () => void;
}

const createStoppedError = () => {
	const e = new Error("Plannotator review session was stopped.");
	e.name = BROWSER_SESSION_STOPPED;
	return e;
};

export function startNativePlanReviewSession(
	pi: ExtensionAPI,
	signal?: AbortSignal,
): NativePlanReviewSession {
	const reviewId = randomUUID();
	const listeners = new Set<(result: PlanReviewDecision) => void | Promise<void>>();
	let settled = false;
	let resolveDecision: ((result: PlanReviewDecision) => void) | undefined;
	let rejectDecision: ((err: Error) => void) | undefined;
	const decision = new Promise<PlanReviewDecision>((resolve, reject) => {
		resolveDecision = resolve;
		rejectDecision = reject;
	});
	// A pending review that nothing awaits (stop() before waitForDecision, or a
	// caller that only registers onDecision) must not crash the process with an
	// unhandled rejection.
	decision.catch(() => {});

	const settle = (result: PlanReviewDecision) => {
		if (settled) return;
		settled = true;
		cleanup();
		resolveDecision?.(result);
		for (const listener of [...listeners]) {
			try {
				void listener(result);
			} catch {
				// One broken listener must not shield the others.
			}
		}
	};
	const stop = () => {
		if (settled) return;
		settled = true;
		cleanup();
		rejectDecision?.(createStoppedError());
	};
	const onBusDecision = (payload: unknown) => {
		const event = payload as Partial<PlannotatorReviewDecisionEvent> | undefined;
		if (!event || event.reviewId !== reviewId || typeof event.approved !== "boolean") return;
		pi.events.emit(PLANNOTATOR_REVIEW_DECISION_ACK_CHANNEL, { reviewId });
		settle({
			approved: event.approved,
			...(typeof event.feedback === "string" && event.feedback.length > 0
				? { feedback: event.feedback }
				: {}),
		});
	};
	const unsubscribe = pi.events.on(PLANNOTATOR_REVIEW_DECISION_CHANNEL, onBusDecision);
	const onAbort = () => stop();
	const cleanup = () => {
		unsubscribe?.();
		signal?.removeEventListener("abort", onAbort);
	};
	if (signal?.aborted) stop();
	else signal?.addEventListener("abort", onAbort, { once: true });

	return {
		reviewId,
		waitForDecision: () => decision,
		onDecision: (listener) => {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		stop,
	};
}
