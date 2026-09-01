import { createEventBus, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import {
	PLANNOTATOR_REVIEW_DECISION_ACK_CHANNEL,
	PLANNOTATOR_REVIEW_DECISION_CHANNEL,
	startNativePlanReviewSession,
} from "./native-review.js";

describe("native plan review", () => {
	it("acknowledges a matching decision before settling", async () => {
		const events = createEventBus();
		const review = startNativePlanReviewSession({ events } as unknown as ExtensionAPI);
		let acknowledgedReviewId: string | undefined;
		const unsubscribe = events.on(PLANNOTATOR_REVIEW_DECISION_ACK_CHANNEL, (payload) => {
			acknowledgedReviewId = (payload as { reviewId?: string }).reviewId;
		});

		events.emit(PLANNOTATOR_REVIEW_DECISION_CHANNEL, {
			reviewId: review.reviewId,
			approved: true,
		});

		await expect(review.waitForDecision()).resolves.toEqual({ approved: true });
		expect(acknowledgedReviewId).toBe(review.reviewId);
		unsubscribe();
	});
});
