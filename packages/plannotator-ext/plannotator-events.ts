import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getLastAssistantMessageText } from "./assistant-message.ts";
import { getStartupErrorMessage } from "./native-review.ts";

export const PLANNOTATOR_REQUEST_CHANNEL = "plannotator:request" as const;
export const PLANNOTATOR_PLAN_APPROVED_CHANNEL = "plannotator:plan-approved" as const;
export const PLANNOTATOR_HOST_STATE_CHANNEL = "plannotator:host-state" as const;
export const PLANNOTATOR_HOST_NOTICE_CHANNEL = "plannotator:host-notice" as const;
export const PLANNOTATOR_TIMEOUT_MS = 5_000;

export interface PlannotatorHostStateEvent {
	phase: "idle" | "planning" | "executing";
	planFilePath: string | null;
	review: { reviewId: string; url?: string } | null;
	checklist: Array<{ step: number; text: string; completed: boolean }>;
}

export type PlannotatorAction = "plan-mode";

export interface PlannotatorHandledResponse<T> {
	status: "handled";
	result: T;
}

export interface PlannotatorUnavailableResponse {
	status: "unavailable";
	error?: string;
}

export interface PlannotatorErrorResponse {
	status: "error";
	error: string;
}

export type PlannotatorResponse<T> =
	| PlannotatorHandledResponse<T>
	| PlannotatorUnavailableResponse
	| PlannotatorErrorResponse;

export interface PlannotatorRequestBase<A extends PlannotatorAction, P, R> {
	requestId: string;
	action: A;
	payload: P;
	respond: (response: PlannotatorResponse<R>) => void;
}

export interface PlannotatorPlanModePayload {
	mode?: "enter" | "exit" | "toggle" | "status";
}

export interface PlannotatorPlanModeResult {
	phase: "idle" | "planning" | "executing";
}

export interface PlannotatorPlanApprovedEvent {
	cwd: string;
	planFilePath: string;
	planContent: string;
	feedback?: string;
}

export type PlannotatorRequestMap = {
	"plan-mode": PlannotatorRequestBase<"plan-mode", PlannotatorPlanModePayload, PlannotatorPlanModeResult>;
};
export type PlannotatorRequest = PlannotatorRequestMap[PlannotatorAction];
export type PlannotatorResponseMap = {
	"plan-mode": PlannotatorResponse<PlannotatorPlanModeResult>;
};
function isPlannotatorAction(value: unknown): value is PlannotatorAction {
	return value === "plan-mode";
}

function createActiveSessionContext() {
	let currentCtx: ExtensionContext | undefined;

	return {
		set(ctx: ExtensionContext): void {
			currentCtx = ctx;
		},
		clear(): void {
			currentCtx = undefined;
		},
		get(): ExtensionContext | undefined {
			return currentCtx;
		},
	};
}

export interface PlannotatorEventListenerOptions {
	handlePlanMode?: (
		mode: NonNullable<PlannotatorPlanModePayload["mode"]>,
		ctx: ExtensionContext,
	) => Promise<PlannotatorPlanModeResult> | PlannotatorPlanModeResult;
}

export function registerPlannotatorEventListeners(
	pi: ExtensionAPI,
	options: PlannotatorEventListenerOptions = {},
): void {
	const activeSessionContext = createActiveSessionContext();

	// Plannotator event requests are handled against the latest active session.
	// The active context is intentionally session-scoped and replaced on each session_start.
	pi.on("session_start", async (_event, ctx) => {
		activeSessionContext.set(ctx);
	});
	pi.events.on(PLANNOTATOR_REQUEST_CHANNEL, async (data) => {
		const request = data as Partial<PlannotatorRequest> | null;
		const ctx = activeSessionContext.get();

		if (!request || typeof request.respond !== "function" || !isPlannotatorAction(request.action)) {
			return;
		}

		try {
			if (!ctx) {
				request.respond({ status: "unavailable", error: "Plannotator context is not ready yet." });
				return;
			}

			switch (request.action) {
				case "plan-mode": {
					if (!options.handlePlanMode) {
						request.respond({ status: "unavailable", error: "Plan mode control is not available in this session." });
						return;
					}
					const mode = request.payload?.mode ?? "toggle";
					if (mode !== "enter" && mode !== "exit" && mode !== "toggle" && mode !== "status") {
						request.respond({ status: "error", error: "Invalid plan-mode payload.mode." });
						return;
					}
					const result = await options.handlePlanMode(mode, ctx);
					request.respond({ status: "handled", result });
					return;
				}
			}
		} catch (err) {
			const message = getStartupErrorMessage(err);
			if (/unavailable|not available/i.test(message)) {
				request.respond({ status: "unavailable", error: message });
				return;
			}
			request.respond({ status: "error", error: message });
		}
	});
}

export {
	getLastAssistantMessageText,
	getStartupErrorMessage,
};
