import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { startPlanReviewServer } from "./server.ts";
import { BROWSER_SESSION_STOPPED } from "./browser-session-error.ts";
import { openBrowser, isRemoteSession } from "./server/network.ts";
import { loadConfig, resolveSharingEnabled } from "./generated/config.ts";
import {
	getPlanBrowserHtml,
	getStartupErrorMessage,
	hasPlanBrowserHtml,
} from "./plannotator-browser-runtime.ts";
export { getLastAssistantMessageText } from "./assistant-message.ts";
export {
	getStartupErrorMessage,
	hasPlanBrowserHtml,
} from "./plannotator-browser-runtime.ts";

export interface PlanReviewDecision {
	approved: boolean;
	feedback?: string;
	savedPath?: string;
	agentSwitch?: string;
	permissionMode?: string;
}

export interface BrowserDecisionSession<T> {
	url: string;
	waitForDecision: () => Promise<T>;
	stop: () => void;
}

// stop -> registration timestamp. The timestamp lets self-preemption skip
// sessions registered after the failing start began (a concurrent sibling's
// fresh bind, not a stale leftover).
const activeBrowserSessionStops = new Map<() => void, number>();

function registerSessionStop(stop: () => void): () => void {
	activeBrowserSessionStops.set(stop, Date.now());
	return () => activeBrowserSessionStops.delete(stop);
}

// Exception-safe: one broken stop must not shield the remaining sessions.
function runSessionStops(stops: Iterable<() => void>): void {
	for (const stop of [...stops]) {
		try {
			stop();
		} catch (err) {
			console.error(
				`Plannotator: failed to stop a browser session: ${err instanceof Error ? err.message : String(err)}`,
			);
		}
	}
}

export function stopAllBrowserDecisionSessions(): void {
	runSessionStops(activeBrowserSessionStops.keys());
}

/** Test seam: number of live tracked browser sessions. */
export function getActiveBrowserSessionCount(): number {
	return activeBrowserSessionStops.size;
}

const createStoppedError = () => {
	const e = new Error("Plannotator browser session was stopped.");
	e.name = BROWSER_SESSION_STOPPED;
	return e;
};

export interface PlanReviewBrowserSession extends BrowserDecisionSession<PlanReviewDecision> {
	reviewId: string;
	onDecision: (listener: (result: PlanReviewDecision) => void | Promise<void>) => () => void;
}

function delay(ms: number): Promise<void> {
	return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

// Both fixed-port bind failures from listenOnPort: a single busy port and an
// exhausted explicit range.
const PORT_IN_USE_PATTERN = /\bPort \d+ in use\b|\bPort selection .+ exhausted\b/;

// A fixed-port session (remote mode) abandoned without a decision keeps its
// server listening forever in this long-lived pi process, so the next
// command's bind fails (#1159). Live tracked sessions are the only thing
// self-preemption may stop, and only those registered before the failing
// start began: a session registered after that is a concurrent sibling's
// fresh bind, not a stale leftover. Returns whether anything was stopped.
function stopBrowserSessionsRegisteredBefore(startedAt: number): boolean {
	const stale = [...activeBrowserSessionStops]
		.filter(([, registeredAt]) => registeredAt < startedAt)
		.map(([stop]) => stop);
	if (stale.length === 0) return false;
	runSessionStops(stale);
	return true;
}

export async function startServerWithSelfPreemption<T>(
	start: () => Promise<T>,
	stopPrevious: (startedAt: number) => boolean = stopBrowserSessionsRegisteredBefore,
): Promise<T> {
	const startedAt = Date.now();
	try {
		return await start();
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		if (!PORT_IN_USE_PATTERN.test(message) || !stopPrevious(startedAt)) throw err;
		// A fresh command is the user asking for a new review surface, so stale
		// same-process sessions lose the port. Random-port local sessions never
		// collide, so concurrent local sessions are untouched; a port held by
		// another process still fails after the retry.
		await delay(150);
		return await start();
	}
}

async function openBrowserForServer(serverUrl: string, ctx: ExtensionContext): Promise<void> {
	const browserResult = await openBrowser(serverUrl);
	if (isRemoteSession()) {
		ctx.ui.notify(`[Plannotator] ${serverUrl}`, "info");
	} else if (!browserResult.opened) {
		ctx.ui.notify(`Open this URL to review: ${serverUrl}`, "info");
	}
}

async function openBrowserAndWait<T>(
	server: { url: string; stop: () => void },
	ctx: ExtensionContext,
	waitForResult: () => Promise<T>,
): Promise<T> {
	// The archive path never goes through startBrowserDecisionSession, so track
	// its stop here for the session's lifetime: an abandoned archive tab would
	// otherwise hold its fixed port beyond self-preemption's reach (#1159).
	const unregister = registerSessionStop(server.stop);
	try {
		await openBrowserForServer(server.url, ctx);
		return await waitForDecisionWithCleanup(server, waitForResult);
	} finally {
		unregister();
	}
}

async function waitForDecisionWithCleanup<T>(
	server: { url: string; stop: () => void },
	waitForResult: () => Promise<T>,
): Promise<T> {
	try {
		const result = await waitForResult();
		await delay(1500);
		return result;
	} finally {
		server.stop();
	}
}

export function startBrowserDecisionSession<T>(
	server: { url: string; stop: () => void },
	ctx: ExtensionContext,
	waitForResult: () => Promise<T>,
	signal?: AbortSignal,
): BrowserDecisionSession<T> {
	let stopped = false;
	let stopReject: ((err: Error) => void) | undefined;
	let decisionPromise: Promise<T> | undefined;
	const stop = () => {
		if (stopped) return;
		stopped = true;
		unregister();
		signal?.removeEventListener("abort", stop);
		server.stop();
		stopReject?.(createStoppedError());
		stopReject = undefined;
	};
	const unregister = registerSessionStop(stop);
	if (signal?.aborted) {
		// An already-cancelled tool must never open a tab: stop before launch.
		stop();
	} else {
		signal?.addEventListener("abort", stop, { once: true });
		if (process.env.PLANNOTATOR_EMBEDDED !== "1") {
			// Fire-and-forget so the caller's turn is not blocked on a browser launch.
			// Nothing may escape: an unhandled rejection here (a launcher that failed,
			// or a `ctx` invalidated by a session replacement while the browser was
			// opening) is an uncaught error that kills the whole pi process.
			void openBrowserForServer(server.url, ctx).catch((err: unknown) => {
				console.error(
					`Plannotator: could not announce the browser URL ${server.url}: ${err instanceof Error ? err.message : String(err)}`,
				);
			});
		}
	}

	return {
		url: server.url,
		waitForDecision: () => {
			if (decisionPromise) return decisionPromise;
			if (stopped) return Promise.reject(createStoppedError());
			decisionPromise = (async () => {
				const stoppedPromise = new Promise<never>((_, reject) => {
					stopReject = reject;
				});
				try {
					const result = await Promise.race([waitForResult(), stoppedPromise]);
					stopReject = undefined;
					await delay(1500);
					return result;
				} finally {
					stop();
				}
			})();
			return decisionPromise;
		},
		stop,
	};
}

export async function startPlanReviewBrowserSession(
	ctx: ExtensionContext,
	planContent: string,
	signal?: AbortSignal,
): Promise<PlanReviewBrowserSession> {
	if (!ctx.hasUI) {
		throw new Error("Plannotator browser review is unavailable in this session.");
	}
	const planHtmlContent = getPlanBrowserHtml();
	if (!planHtmlContent) {
		throw new Error("Plannotator browser review is unavailable in this session.");
	}

	const server = await startServerWithSelfPreemption(() => startPlanReviewServer({
		plan: planContent,
		htmlContent: planHtmlContent,
		origin: "pi",
		sharingEnabled: resolveSharingEnabled(loadConfig()),
		shareBaseUrl: process.env.PLANNOTATOR_SHARE_URL || undefined,
		pasteApiUrl: process.env.PLANNOTATOR_PASTE_URL || undefined,
	}));

	const session = startBrowserDecisionSession(server, ctx, server.waitForDecision, signal);
	server.onDecision(() => {
		setTimeout(() => session.stop(), 1500);
	});

	return {
		...session,
		reviewId: server.reviewId,
		onDecision: server.onDecision,
	};
}

export async function openPlanReviewBrowser(
	ctx: ExtensionContext,
	planContent: string,
	signal?: AbortSignal,
): Promise<PlanReviewDecision> {
	const session = await startPlanReviewBrowserSession(ctx, planContent, signal);
	return session.waitForDecision();
}

export async function openArchiveBrowserAction(
	ctx: ExtensionContext,
	customPlanPath?: string,
): Promise<{ opened: boolean }> {
	if (!ctx.hasUI) {
		throw new Error("Plannotator archive browser is unavailable in this session.");
	}
	const planHtmlContent = getPlanBrowserHtml();
	if (!planHtmlContent) {
		throw new Error("Plannotator archive browser is unavailable in this session.");
	}

	const server = await startServerWithSelfPreemption(() => startPlanReviewServer({
		plan: "",
		htmlContent: planHtmlContent,
		origin: "pi",
		mode: "archive",
		customPlanPath,
		sharingEnabled: resolveSharingEnabled(loadConfig()),
		shareBaseUrl: process.env.PLANNOTATOR_SHARE_URL || undefined,
		pasteApiUrl: process.env.PLANNOTATOR_PASTE_URL || undefined,
	}));

	return openBrowserAndWait(server, ctx, async () => {
		if (server.waitForDone) {
			await server.waitForDone();
		}
		return { opened: true };
	});
}
