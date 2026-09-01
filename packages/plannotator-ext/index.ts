/**
 * Plannotator Pi Extension — File-based plan mode with visual browser review.
 *
 * During planning the agent writes any markdown file anywhere inside cwd and
 * calls plannotator_submit_plan with the path. The user reviews in the
 * browser UI and can approve, deny with annotations, or request changes.
 *
 * Features:
 * - /plannotator-plan-mode command or Ctrl+Alt+P to toggle
 * - --plan flag to start in planning mode
 * - Bash unrestricted during planning (prompt-guided)
 * - Writes restricted to markdown files inside cwd during planning
 * - plannotator_submit_plan tool with browser-based visual approval
 * - [DONE:n] markers for execution progress tracking
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { basename, relative, resolve } from "node:path";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";
import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Key } from "@earendil-works/pi-tui";
import { buildPromptVariables, formatTodoList, loadPlannotatorConfig, renderTemplate, resolveExecutionMode, resolvePhaseProfile } from "./config.ts";
import {
	type ChecklistItem,
	extractDoneSteps,
	parseChecklist,
} from "./generated/checklist.ts";
import { persistPlanStatuses } from "./plan-status.ts";

import { loadConfig, resolveTodoProviderEnabled, resolveUseJina } from "./generated/config.ts";
import { readImprovementHook } from "./generated/improvement-hooks.ts";
import { composeImproveContext } from "./generated/pfm-reminder.ts";
import {
	PLANNOTATOR_HOST_NOTICE_CHANNEL,
	PLANNOTATOR_HOST_STATE_CHANNEL,
	PLANNOTATOR_PLAN_APPROVED_CHANNEL,
	type PlannotatorHostStateEvent,
	type PlannotatorPlanApprovedEvent,
	registerPlannotatorEventListeners,
} from "./plannotator-events.ts";
import { createPiTodosProvider, detectPiTodos } from "./todo-providers/pi-todos.ts";
import {
	getStartupErrorMessage,
	startNativePlanReviewSession,
} from "./native-review.ts";
import { parsePlanMarkdown, type ParsedPlanMarkdown } from "./plan-parse.ts";
import {
	getAssistantMessageText,
} from "./assistant-message.ts";
import {
	isCtxAlive,
	registerCurrentPiSession,
} from "./current-pi-session.ts";
import {
	applyPhaseTools,
	isPlanWritePathAllowed,
	PLAN_SUBMIT_TOOL,
	PLAN_UPDATE_TOOL,
	releasePhaseTools,
	type Phase,
} from "./tool-scope.ts";
import { isBrowserSessionStoppedError } from "./browser-session-error.ts";

// ── Types ──────────────────────────────────────────────────────────────

type PlannotatorPromptsModule = typeof import("./generated/prompts.ts");

let promptsModulePromise: Promise<PlannotatorPromptsModule> | undefined;

function loadPlannotatorPrompts(): Promise<PlannotatorPromptsModule> {
	if (!promptsModulePromise) {
		promptsModulePromise = import("./generated/prompts.ts").catch((error: unknown) => {
			promptsModulePromise = undefined;
			throw error;
		});
	}
	return promptsModulePromise;
}


type SavedPhaseState = {
	model?: { provider: string; id: string };
	thinkingLevel: ThinkingLevel;
};

type PersistedPlannotatorState = {
	phase: Phase;
	lastSubmittedPath?: string;
	savedState?: SavedPhaseState;
	phaseAddedTools?: string[];
	/** Whether the current phase's entry framing message was already delivered. */
	framingDelivered?: boolean;
	/**
	 * Whether a "plan mode off" notice is still owed to the model after a
	 * planning/executing → idle transition (#1320). Set on every return to
	 * idle from a phase, cleared when the notice is delivered or when a new
	 * phase entry supersedes it. Never set on fresh sessions, so an idle
	 * session that never entered plan mode still injects nothing (#1269).
	 */
	idleNoticePending?: boolean;
	/** A submitted planning tool call was awaiting an interactive decision. */
	reviewPending?: boolean;
};

/**
 * One-shot countermand delivered on the first prompt after a planning or
 * executing phase returns to idle (#1320). It is the SOLE mechanism ending
 * plan mode in the conversation: delivered framing stays in history untouched
 * (#1380 — removing it from mid-history shifted every later message and
 * invalidated the provider's cached prefix), so the model's plan-mode steering
 * — its own turns, blocked-write tool results, and the framing itself — is
 * neutralized by this explicit notice, never by silent removal.
 */
const PLAN_MODE_OFF_NOTICE = `[PLANNOTATOR - PLAN MODE OFF]
Plannotator plan mode has ended. Disregard all earlier Plannotator planning or execution instructions from this session: the planning restrictions (markdown-only writes, plan submission for review) and the execution checklist protocol ([DONE:n] markers) no longer apply, and the plan-submission tool is no longer available. Full tool access is restored — respond and use tools normally. If the user wants planning again, they will re-enable plan mode.`;

function getPlanReviewAvailabilityWarning(options: { hasUI: boolean }): string | null {
	if (options.hasUI) return null;
	return "Plannotator: interactive plan review is unavailable in this session (no UI support). Plans will auto-approve on exit_plan_mode.";
}

/**
 * Warning for hosts whose extension context lacks `ctx.isProjectTrusted`
 * (#1353). Two audiences reach this path: real Pi older than 0.79.1 (the
 * release that added the capability) and forks like oh-my-pi that have not
 * adopted it. Neither Pi's nor oh-my-pi's extension context exposes a host
 * name or version, so the two are not reliably distinguishable at runtime —
 * the message states the capability gap without guessing which host it is,
 * and must stay true for both. "Bundled and global config still load" is a
 * fact of loadPlannotatorConfig: only project-local config is trust-gated.
 */
export const PROJECT_TRUST_CAPABILITY_WARNING =
	"This host does not expose project trust (ctx.isProjectTrusted, Pi 0.79.1+). Project-local config (.pi/plannotator.json) is disabled; bundled and global config still load.";

export default function plannotator(pi: ExtensionAPI): void {
	const currentPiSession = registerCurrentPiSession(pi);
	let phase: Phase = "idle";
	void registerPlannotatorEventListeners(pi, {
		handlePlanMode: async (mode, ctx) => {
			if (mode === "status") {
				publishHostState();
				return { phase };
			}
			if (mode === "enter") {
				if (phase === "idle") await enterPlanning(ctx);
				return { phase };
			}
			if (mode === "exit") {
				if (phase !== "idle") await exitToIdle(ctx);
				return { phase };
			}
			await togglePlanMode(ctx);
			return { phase };
		},
	});
	let lastSubmittedPath: string | null = null;
	let checklistItems: ChecklistItem[] = [];
	let savedState: SavedPhaseState | null = null;
	let phaseAddedTools: string[] = [];
	let plannotatorConfig = {};
	let justApprovedPlan = false;
	let reviewPending = false;
	// One-shot latch per phase entry: the phase framing message is delivered on
	// the first prompt of a phase and then lives in conversation history, so it
	// must never be re-sent on later prompts of the same phase. Reset at every
	// phase transition; persisted so session resume does not re-deliver.
	let framingDelivered = false;
	// One-shot latch for the plan-mode-off countermand (#1320): armed only by
	// returnToIdle (a genuine planning/executing → idle transition), never on
	// fresh sessions, so the #1269 inject-nothing-while-idle promise holds
	// until plan mode has actually been used. Persisted like framingDelivered
	// so resume/branch switches neither drop nor duplicate the notice.
	let idleNoticePending = false;
	/**
	 * Cleared when this extension instance's session is torn down or replaced.
	 * Pi builds a fresh instance for the replacement session, so this latch only
	 * ever describes the session this closure was created for. It is the cheap
	 * front half of the staleness check; `isCtxAlive` covers teardown paths that
	 * never reach our `session_shutdown` handler.
	 */
	let sessionAlive = true;
	/** Resolved once per execution phase; undefined means widget-only. */
	let todoProvider: ReturnType<typeof createPiTodosProvider> | undefined;
	/** Latch: no provider found, or one sync failed. Cleared on return to idle. */
	let todoProviderDisabled = false;
	let activeReview: PlannotatorHostStateEvent["review"] = null;
	let reviewStarting = false;
	let hostChecklist: ChecklistItem[] = [];
	let lastPlanContent: string | null = null;
	let hostStructure: ParsedPlanMarkdown | null = null;

	/** Remember the plan text every reader saw, so the publisher can re-derive structure. */
	function adoptPlanContent(content: string): ChecklistItem[] {
		lastPlanContent = content;
		hostStructure = null;
		return parseChecklist(content);
	}

	async function persistDoneMarkers(text: string, ctx: ExtensionContext): Promise<number> {
		if (!lastSubmittedPath) return 0;
		const validSteps = new Set(checklistItems.map(({ step }) => step));
		const completedSteps = extractDoneSteps(text).filter((step) => validSteps.has(step));
		if (completedSteps.length === 0) return 0;
		const fullPath = resolve(ctx.cwd, lastSubmittedPath);
		try {
			const content = await persistPlanStatuses(
				fullPath,
				new Map(completedSteps.map((step) => [step, "completed" as const])),
			);
			checklistItems = adoptPlanContent(content);
			return completedSteps.length;
		} catch (error) {
			try {
				checklistItems = adoptPlanContent(readFileSync(fullPath, "utf8"));
			} catch {
				phase = "idle";
				lastSubmittedPath = null;
				activeReview = null;
				reviewPending = false;
				justApprovedPlan = false;
				checklistItems = [];
				hostChecklist = [];
				lastPlanContent = null;
				hostStructure = null;
				idleNoticePending = true;
				publishHostState();
				updateStatus(ctx);
				persistState();
			}
			ctx.ui.notify(
				`Plannotator could not persist checklist progress: ${error instanceof Error ? error.message : String(error)}`,
				"error",
			);
			return 0;
		}
	}

	function publishHostState(): void {
		if (checklistItems.length > 0) hostChecklist = checklistItems.map((item) => ({ ...item }));
		if (hostStructure === null && lastPlanContent !== null) {
			try {
				hostStructure = parsePlanMarkdown(lastPlanContent);
			} catch {
				hostStructure = null;
			}
		}
		// The flat checklist is the live progress record ([DONE:n] ticks mutate
		// it); overlay its completion back onto the parsed structure by step so
		// both views can never disagree.
		const completedSteps = new Set(
			hostChecklist.filter((item) => item.completed).map((item) => item.step),
		);
		const overlayTask = <T extends { step: number; status: string }>(task: T): T =>
			completedSteps.has(task.step) && task.status !== "completed"
				? { ...task, status: "completed" }
				: task;
		const structured = hostStructure === null || hostStructure.stages.length === 0
			? {}
			: {
					title: hostStructure.title,
					revision: hostStructure.revision,
					sections: hostStructure.sections,
					stages: hostStructure.stages.map((stage) => ({
						...stage,
						tasks: stage.tasks.map((task) => ({
							...overlayTask(task),
							subtasks: task.subtasks.map((subtask) => overlayTask(subtask)),
						})),
						acceptance: stage.acceptance.map((criterion) =>
							completedSteps.has(criterion.step) && criterion.status !== "passed"
								? { ...criterion, status: "passed" as const }
								: criterion,
						),
					})),
				};
		pi.events.emit(PLANNOTATOR_HOST_STATE_CHANNEL, {
			phase,
			planFilePath: lastSubmittedPath,
			review: activeReview,
			checklist: hostChecklist.map((item) => ({ ...item })),
			...(lastPlanContent === null ? {} : { planContent: lastPlanContent }),
			...structured,
		} satisfies PlannotatorHostStateEvent);
	}

	function publishHostNotice(message: string): void {
		pi.events.emit(PLANNOTATOR_HOST_NOTICE_CHANNEL, { message });
	}

	pi.on("session_start", (_event, ctx) => {
		sessionAlive = true;
		currentPiSession.update(ctx);
	});

	pi.on("session_shutdown", () => {
		sessionAlive = false;
		currentPiSession.clear();
		// Browser sessions deliberately outlive in-process session replacement so
		// a tab opened before /new can still deliver feedback to the replacement
		// session (withCurrentPiSessionFallbackHeader). On real process teardown
		// the OS frees the ports, and port self-preemption reclaims any stale
		// fixed-port session on the next command.
	});

	// ── Flags ────────────────────────────────────────────────────────────

	pi.registerFlag("plan", {
		description: "Start in plan mode (restricted exploration and planning)",
		type: "boolean",
		default: false,
	});

	// ── Helpers ──────────────────────────────────────────────────────────

	function getPhaseProfile(): ReturnType<typeof resolvePhaseProfile> | undefined {
		if (phase === "planning" || phase === "executing") {
			return resolvePhaseProfile(plannotatorConfig, phase);
		}
		return undefined;
	}

	function updateStatus(ctx: ExtensionContext): void {
		const profile = getPhaseProfile();
		if (phase === "executing" && checklistItems.length > 0) {
			const completed = checklistItems.filter((t) => t.completed).length;
			ctx.ui.setStatus(
				"plannotator",
				ctx.ui.theme.fg("accent", `📋 ${completed}/${checklistItems.length}`),
			);
		} else if (phase === "planning" && profile?.statusLabel) {
			ctx.ui.setStatus("plannotator", ctx.ui.theme.fg("warning", profile.statusLabel));
		} else if (phase === "executing" && profile?.statusLabel) {
			ctx.ui.setStatus("plannotator", ctx.ui.theme.fg("accent", profile.statusLabel));
		} else {
			ctx.ui.setStatus("plannotator", undefined);
		}
	}

	function updateWidget(ctx: ExtensionContext): void {
		if (phase === "executing" && checklistItems.length > 0) {
			const lines = checklistItems.map((item) => {
				if (item.completed) {
					return (
						ctx.ui.theme.fg("success", "☑ ") +
						ctx.ui.theme.fg("muted", ctx.ui.theme.strikethrough(item.text))
					);
				}
				return `${ctx.ui.theme.fg("muted", "☐ ")}${item.text}`;
			});
			ctx.ui.setWidget("plannotator-progress", lines);
		} else {
			ctx.ui.setWidget("plannotator-progress", undefined);
		}
	}

	/**
	 * Mirror the checklist into an editable todo provider, when one is present.
	 *
	 * Additive by design: the progress widget above stays exactly as it was.
	 * pi-todos renders its list on demand in `/todos` and has no live surface,
	 * so replacing the widget with it would trade a visible tracker for files
	 * behind a keystroke. Failures are swallowed after one notification —
	 * a todo mirror must never break plan execution. Runs even when the
	 * checklist is empty so a resubmitted-empty plan still reconciles
	 * (closing todos it used to own) instead of leaving them orphaned.
	 */
	async function syncTodoProvider(ctx: ExtensionContext): Promise<void> {
		if (todoProviderDisabled) return;
		if (phase !== "executing" || !lastSubmittedPath) return;
		if (!todoProvider) {
			if (!resolveTodoProviderEnabled(loadConfig()) || !detectPiTodos(ctx.cwd)) {
				todoProviderDisabled = true;
				return;
			}
			todoProvider = createPiTodosProvider({
				cwd: ctx.cwd,
				sessionId: ctx.sessionManager.getSessionId(),
			});
		}
		// Tag on the cwd-relative path: it is stable across machines and reads
		// cleanly in the /todos detail view, which renders raw tags.
		const planId = relative(ctx.cwd, resolve(ctx.cwd, lastSubmittedPath)) || lastSubmittedPath;
		try {
			await todoProvider.sync(checklistItems, planId);
		} catch (error) {
			todoProviderDisabled = true;
			ctx.ui.notify(
				`Plannotator: ${todoProvider.name} sync failed, continuing with the progress widget only. ${
					error instanceof Error ? error.message : String(error)
				}`,
				"warning",
			);
		}
	}

	function captureSavedState(ctx: ExtensionContext): void {
		savedState = {
			model: ctx.model ? { provider: ctx.model.provider, id: ctx.model.id } : undefined,
			thinkingLevel: pi.getThinkingLevel(),
		};
	}

	function persistState(): void {
		pi.appendEntry("plannotator", {
			phase,
			lastSubmittedPath,
			savedState,
			phaseAddedTools,
			framingDelivered,
			idleNoticePending,
			reviewPending,
		});
		publishHostState();
	}

	async function applyModelRef(
		ref: { provider: string; id: string },
		ctx: ExtensionContext,
		reason: string,
	): Promise<void> {
		const model = ctx.modelRegistry.find(ref.provider, ref.id);
		if (!model) {
			ctx.ui.notify(`Plannotator: ${reason} model ${ref.provider}/${ref.id} not found.`, "warning");
			return;
		}

		const success = await pi.setModel(model);
		if (!success) {
			ctx.ui.notify(`Plannotator: no API key for ${ref.provider}/${ref.id}.`, "warning");
		}
	}

	async function restoreSavedState(ctx: ExtensionContext): Promise<void> {
		if (!savedState) return;

		if (savedState.model) {
			await applyModelRef(savedState.model, ctx, "restore");
		}
		pi.setThinkingLevel(savedState.thinkingLevel);
	}

	function releaseAddedPhaseTools(): void {
		const activeTools = pi.getActiveTools();
		const nextTools = releasePhaseTools(activeTools, phaseAddedTools);
		phaseAddedTools = [];
		if (nextTools.length !== activeTools.length) pi.setActiveTools(nextTools);
	}

	async function applyPhaseConfig(ctx: ExtensionContext, opts: { restoreSavedState?: boolean } = {}): Promise<void> {
		const profile = getPhaseProfile();
		if (opts.restoreSavedState !== false && savedState) {
			await restoreSavedState(ctx);
		}

		if (phase === "planning" || phase === "executing") {
			const activeTools = pi.getActiveTools();
			const configuredTools = profile?.activeTools ?? [];
			// A user-supplied phases.planning.activeTools replaces the built-in list
			// wholesale, so union the submit tool back in: the planning system prompt
			// instructs the model to call it, and without it the phase is a dead end.
			// It still flows through phaseAddedTools, so it is released on phase exit
			// like any other addition (and is skipped if already active).
			const phaseTools =
				phase === "planning" && !configuredTools.includes(PLAN_SUBMIT_TOOL)
					? [...configuredTools, PLAN_SUBMIT_TOOL]
					: configuredTools;
			const selection = applyPhaseTools(
				activeTools,
				phaseAddedTools,
				phaseTools,
				profile?.removeTools ?? [],
			);
			phaseAddedTools = selection.addedTools;
			if (
				selection.activeTools.length !== activeTools.length ||
				selection.activeTools.some((tool, index) => tool !== activeTools[index])
			) {
				pi.setActiveTools(selection.activeTools);
			}
		}

		if (profile?.model) {
			await applyModelRef(profile.model, ctx, phase);
		}

		if (profile?.thinking) {
			// The config accepts every level current Pi knows, which is a superset
			// of the `ThinkingLevel` union of the pinned Pi floor (#1304). Pi clamps
			// a level the running model does not support, so handing it one this
			// build's types have not heard of yet is safe.
			pi.setThinkingLevel(profile.thinking as ThinkingLevel);
		}

		updateStatus(ctx);
		updateWidget(ctx);
		await syncTodoProvider(ctx);
	}

	async function enterPlanning(ctx: ExtensionContext): Promise<void> {
		phase = "planning";
		framingDelivered = false;
		// An undelivered plan-mode-off notice is superseded by the planning
		// framing this entry will deliver; dropping it avoids a stale "plan
		// mode is off" landing after plan mode came back on.
		idleNoticePending = false;
		reviewPending = false;
		checklistItems = [];
		hostChecklist = [];
		captureSavedState(ctx);
		await applyPhaseConfig(ctx, { restoreSavedState: false });
		persistState();
		ctx.ui.notify(
			"Plannotator: planning mode enabled.",
		);
		const warning = getPlanReviewAvailabilityWarning({ hasUI: ctx.hasUI });
		if (warning) {
			ctx.ui.notify(warning, "warning");
		}
	}

	/**
	 * The single exit sequence every idle transition shares: drop phase state,
	 * hand back the tools the phase added, restore the pre-phase model/thinking
	 * level, then refresh the UI and persist. Callers add their own messaging,
	 * session entries, and events around it.
	 */
	async function returnToIdle(ctx: ExtensionContext): Promise<void> {
		phase = "idle";
		framingDelivered = false;
		// Every caller reaches here FROM planning or executing, so this is the
		// one place the plan-mode-off notice may be armed (#1320). Fresh idle
		// sessions never pass through returnToIdle and stay injection-free.
		idleNoticePending = true;
		reviewPending = false;
		checklistItems = [];
		lastSubmittedPath = null;
		// Re-detect for the next plan: a provider that appeared (or a transient
		// write failure) should not be decided once for the whole session.
		todoProvider = undefined;
		todoProviderDisabled = false;

		releaseAddedPhaseTools();
		await restoreSavedState(ctx);
		savedState = null;
		updateStatus(ctx);
		updateWidget(ctx);
		persistState();
	}

	async function exitToIdle(ctx: ExtensionContext): Promise<void> {
		await returnToIdle(ctx);
		ctx.ui.notify("Plannotator: disabled. Full access restored.");
	}

	async function togglePlanMode(ctx: ExtensionContext): Promise<void> {
		if (phase === "idle") {
			await enterPlanning(ctx);
		} else {
			await exitToIdle(ctx);
		}
	}

	async function handoffApprovedPlan(
		ctx: ExtensionContext,
		planFilePath: string,
		planContent: string,
		feedback?: string,
	): Promise<void> {
		pi.appendEntry("plannotator-handoff", { planFilePath });
		await returnToIdle(ctx);
		pi.events.emit(PLANNOTATOR_PLAN_APPROVED_CHANNEL, {
			cwd: ctx.cwd,
			planFilePath,
			planContent,
			...(feedback ? { feedback } : {}),
		} satisfies PlannotatorPlanApprovedEvent);
		ctx.ui.notify("Plannotator: approved plan handed off for external execution.");
	}

	async function reviewSubmittedPlan(
		ctx: ExtensionContext,
		inputPath: string,
		planContent: string,
		signal?: AbortSignal,
	) {
		if (reviewStarting || activeReview !== null) {
			return {
				content: [{ type: "text", text: "A Plannotator review is already active." }],
				details: { approved: false },
			};
		}
		reviewStarting = true;
		reviewPending = true;
		persistState();
		let result: { approved: boolean; feedback?: string };
		try {
			const review = startNativePlanReviewSession(pi, signal);
			reviewStarting = false;
			activeReview = { reviewId: review.reviewId };
			publishHostState();
			try {
				result = await review.waitForDecision();
			} finally {
				activeReview = null;
				publishHostState();
			}
			reviewPending = false;
			persistState();
		} catch (err) {
			reviewStarting = false;
			reviewPending = false;
			activeReview = null;
			persistState();
			publishHostState();
			// A stopped session is an outcome, not a startup failure: the review
			// was closed (cancellation or port self-preemption) before a decision.
			if (isBrowserSessionStoppedError(err)) {
				ctx.ui.notify("Plan review session was closed before a decision.", "info");
				return {
					content: [
						{
							type: "text",
							text: "The plan review browser session was closed before a decision was made. The plan was neither approved nor rejected; resubmit to reopen review.",
						},
					],
					details: { approved: false },
				};
			}
			const message = `Failed to start plan review UI: ${getStartupErrorMessage(err)}`;
			ctx.ui.notify(message, "error");
			publishHostNotice(message);
			return {
				content: [{ type: "text", text: message }],
				details: { approved: false },
			};
		}
	
		if (result.approved) {
			if (resolveExecutionMode(plannotatorConfig) === "external") {
				await handoffApprovedPlan(ctx, inputPath, planContent, result.feedback);
				return {
					content: [{ type: "text", text: "Plan approved and handed off for external execution." }],
					details: {
						approved: true,
						handedOff: true,
						...(result.feedback ? { feedback: result.feedback } : {}),
					},
					terminate: true,
				};
			}
	
			phase = "executing";
			framingDelivered = false;
			await applyPhaseConfig(ctx, { restoreSavedState: true });
			pi.appendEntry("plannotator-execute", { lastSubmittedPath });
			persistState();
			publishHostState();
			justApprovedPlan = true;
	
			const doneMsg =
				checklistItems.length > 0
					? `After completing each step, include [DONE:n] in your response where n is the step number.`
					: "";
	
			if (result.feedback) {
				const { getPlanApprovedWithNotesPrompt } = await loadPlannotatorPrompts();
				return {
					content: [
						{
							type: "text",
							text: getPlanApprovedWithNotesPrompt("pi", loadConfig(), {
								planFilePath: inputPath,
								doneMsg,
								feedback: result.feedback,
							}),
						},
					],
					details: { approved: true, feedback: result.feedback },
					terminate: true,
				};
			}
	
			const { getPlanApprovedPrompt } = await loadPlannotatorPrompts();
			return {
				content: [
					{
						type: "text",
						text: getPlanApprovedPrompt("pi", loadConfig(), {
							planFilePath: inputPath,
							doneMsg,
						}),
					},
				],
				details: { approved: true },
				terminate: true,
			};
		}
	
		// Denied
		persistState();
		const feedbackText = result.feedback || "Plan rejected. Please revise.";
		const { buildPlanFileRule, getPlanDeniedPrompt, getPlanToolName } = await loadPlannotatorPrompts();
		return {
			content: [
				{
					type: "text",
					text: getPlanDeniedPrompt("pi", loadConfig(), {
						toolName: getPlanToolName("pi"),
						planFileRule: buildPlanFileRule(getPlanToolName("pi"), inputPath),
						feedback: feedbackText,
					}),
				},
			],
			details: { approved: false, feedback: feedbackText },
		};
	}

	// ── Commands & Shortcuts ─────────────────────────────────────────────

	pi.registerCommand("plannotator-plan-mode", {
		description: "Toggle plannotator planning mode",
		handler: async (_args, ctx) => {
			await togglePlanMode(ctx);
		},
	});

	async function resumePendingPlanReview(ctx: ExtensionContext): Promise<void> {
		// Submissions are no longer planning-only, so a restart can interrupt a
		// review begun from idle or executing too — resume by reviewPending
		// alone rather than by phase.
		if (!reviewPending || !lastSubmittedPath) return;
		if (reviewStarting || activeReview !== null) {
			publishHostState();
			return;
		}
		const inputPath = lastSubmittedPath;
		const fullPath = resolve(ctx.cwd, inputPath);
		if (!existsSync(fullPath)) {
			reviewPending = false;
			lastSubmittedPath = null;
			checklistItems = [];
			hostChecklist = [];
			activeReview = null;
			persistState();
			publishHostState();
			const message = `Cannot resume plan review: ${inputPath} no longer exists.`;
			ctx.ui.notify(message, "error");
			publishHostNotice(message);
			return;
		}
		const planContent = readFileSync(fullPath, "utf-8");
		if (!planContent.trim()) {
			reviewPending = false;
			lastSubmittedPath = null;
			checklistItems = [];
			hostChecklist = [];
			activeReview = null;
			persistState();
			publishHostState();
			const message = `Cannot resume plan review: ${inputPath} is empty.`;
			ctx.ui.notify(message, "error");
			publishHostNotice(message);
			return;
		}
		checklistItems = adoptPlanContent(planContent);
		const outcome = await reviewSubmittedPlan(ctx, inputPath, planContent);
		const text = outcome.content.map((part) => part.text).join("\n");
		if (text && (outcome.details.approved || "feedback" in outcome.details)) {
			pi.sendMessage(
				{ customType: "plannotator-recovery", content: text, display: true },
				{ triggerTurn: true, deliverAs: "followUp" },
			);
		}
	}

	pi.registerCommand("plannotator-resume-review", {
		description: "Resume a plan review interrupted by host restart",
		handler: async (_args, ctx) => {
			await resumePendingPlanReview(ctx);
		},
	});

	pi.registerShortcut(Key.ctrlAlt("p"), {
		description: "Toggle plannotator",
		handler: async (ctx) => {
			await togglePlanMode(ctx);
		},
	});

	// ── plannotator_submit_plan Tool ────────────────────────────────────

	pi.registerTool({
		name: PLAN_SUBMIT_TOOL,
		label: "Submit Plan",
		description:
			"Submit your Plannotator plan for user review, from any mode: after writing (or revising) your plan as a markdown file inside the working directory, call this when a change is significant enough to need the operator's sign-off. " +
			"Pass the path to the plan file (e.g. PLAN.md or plans/auth.md). " +
			"The user reviews the plan and can approve, deny with feedback, or annotate it; approval moves execution forward in this same session. " +
			"If denied, edit the same file in place, then call this again with the same path. " +
			"For small revisions that do not need sign-off, use plannotator_update_plan instead.",
		parameters: Type.Object({
			filePath: Type.String({
				description:
					"Path to the markdown plan file, relative to the working directory. Must end in .md or .mdx and resolve inside cwd.",
			}),
		}) as any,

		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const inputPath = (params as { filePath?: string })?.filePath?.trim();
			if (!inputPath) {
				return {
					content: [
						{
							type: "text",
							text: `Error: ${PLAN_SUBMIT_TOOL} requires a filePath argument pointing to your markdown plan file (e.g. "PLAN.md" or "plans/auth.md").`,
						},
					],
					details: { approved: false },
				};
			}

			if (!isPlanWritePathAllowed(inputPath, ctx.cwd)) {
				return {
					content: [
						{
							type: "text",
							text: `Error: plan file must be a markdown file (.md or .mdx) inside the working directory. Rejected: ${inputPath}`,
						},
					],
					details: { approved: false },
				};
			}

			const fullPath = resolve(ctx.cwd, inputPath);

			try {
				if (!statSync(fullPath).isFile()) {
					return {
						content: [
							{
								type: "text",
								text: `Error: ${inputPath} is not a regular file. Write your plan to a markdown file first, then call ${PLAN_SUBMIT_TOOL} with its path.`,
							},
						],
						details: { approved: false },
					};
				}
			} catch {
				return {
					content: [
						{
							type: "text",
							text: `Error: ${inputPath} does not exist. Write your plan using the write tool first, then call ${PLAN_SUBMIT_TOOL} again.`,
						},
					],
					details: { approved: false },
				};
			}

			let planContent: string;
			try {
				planContent = readFileSync(fullPath, "utf-8");
			} catch (err) {
				return {
					content: [
						{
							type: "text",
							text: `Error: failed to read ${inputPath}: ${err instanceof Error ? err.message : String(err)}`,
						},
					],
					details: { approved: false },
				};
			}

			if (planContent.trim().length === 0) {
				return {
					content: [
						{
							type: "text",
							text: `Error: ${inputPath} is empty. Write your plan first, then call ${PLAN_SUBMIT_TOOL} again.`,
						},
					],
					details: { approved: false },
				};
			}

			lastSubmittedPath = inputPath;
			checklistItems = adoptPlanContent(planContent);

			// Non-interactive or no HTML: auto-approve
			if (!ctx.hasUI) {
				if (resolveExecutionMode(plannotatorConfig) === "external") {
					await handoffApprovedPlan(ctx, inputPath, planContent);
					return {
						content: [{ type: "text", text: "Plan approved and handed off for external execution." }],
						details: { approved: true, handedOff: true },
						terminate: true,
					};
				}

				phase = "executing";
				framingDelivered = false;
				await applyPhaseConfig(ctx, { restoreSavedState: true });
				pi.appendEntry("plannotator-execute", { lastSubmittedPath });
				persistState();
				justApprovedPlan = true;
				const { getPlanAutoApprovedPrompt } = await loadPlannotatorPrompts();
				return {
					content: [
						{
							type: "text",
							text: getPlanAutoApprovedPrompt("pi", loadConfig()),
						},
					],
					details: { approved: true },
					terminate: true,
				};
			}

			return await reviewSubmittedPlan(ctx, inputPath, planContent, signal);
		},
	});

	// The silent half of the agent-chooses revision gate: adopt or refresh the
	// plan from disk with NO operator review. Significant changes go through
	// plannotator_submit_plan; everything else lands here so the plan works as
	// a live scratchpad in any phase (idle sessions included).
	pi.registerTool({
		name: PLAN_UPDATE_TOOL,
		label: "Update Plan",
		description:
			"Adopt or refresh the Plannotator plan from a markdown file WITHOUT operator review. " +
			"Use this to keep the plan current as you work — after creating a plan in a normal session, ticking checklist items, or making small revisions that do not need sign-off. " +
			"Pass the path to the plan file (e.g. PLAN.md or plans/auth.md); its checklist becomes the live progress list shown to the operator. " +
			"Significant changes to an approved plan should go through " + PLAN_SUBMIT_TOOL + " for review instead.",
		parameters: Type.Object({
			filePath: Type.String({
				description:
					"Path to the markdown plan file, relative to the working directory. Must end in .md or .mdx and resolve inside cwd.",
			}),
		}) as any,

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const inputPath = (params as { filePath?: string })?.filePath?.trim();
			if (!inputPath) {
				return {
					content: [
						{
							type: "text",
							text: `Error: ${PLAN_UPDATE_TOOL} requires a filePath argument pointing to your markdown plan file (e.g. "PLAN.md" or "plans/auth.md").`,
						},
					],
					details: { updated: false },
				};
			}
			if (!isPlanWritePathAllowed(inputPath, ctx.cwd)) {
				return {
					content: [
						{
							type: "text",
							text: `Error: plan file must be a markdown file (.md or .mdx) inside the working directory. Rejected: ${inputPath}`,
						},
					],
					details: { updated: false },
				};
			}
			let planContent: string;
			try {
				planContent = readFileSync(resolve(ctx.cwd, inputPath), "utf-8");
			} catch (err) {
				return {
					content: [
						{
							type: "text",
							text: `Error: failed to read ${inputPath}: ${err instanceof Error ? err.message : String(err)}. Write the plan file first, then call ${PLAN_UPDATE_TOOL} again.`,
						},
					],
					details: { updated: false },
				};
			}
			if (planContent.trim().length === 0) {
				return {
					content: [
						{
							type: "text",
							text: `Error: ${inputPath} is empty. Write your plan first, then call ${PLAN_UPDATE_TOOL} again.`,
						},
					],
					details: { updated: false },
				};
			}

			lastSubmittedPath = inputPath;
			checklistItems = adoptPlanContent(planContent);
			updateStatus(ctx);
			updateWidget(ctx);
			await syncTodoProvider(ctx);
			persistState();

			const completed = checklistItems.filter((item) => item.completed).length;
			const summary = checklistItems.length > 0
				? `Plan updated from ${inputPath}: ${completed}/${checklistItems.length} checklist steps complete.`
				: `Plan updated from ${inputPath} (no checklist steps found — use "- [ ]" checkboxes to track progress).`;
			return {
				content: [
					{
						type: "text",
						text: `${summary} The operator sees this plan live; call ${PLAN_SUBMIT_TOOL} when a change needs their review.`,
					},
				],
				details: { updated: true, steps: checklistItems.length, completed },
			};
		},
	});

	// ── Event Handlers ───────────────────────────────────────────────────

	// Refuse tools the current phase's removeTools stripped. setActiveTools
	// narrowing alone is not durable: Pi re-activates every allow-listed tool
	// whenever its tool registry refreshes (extension tool registration,
	// reload), so a removed tool can silently come back mid-phase. Blocking
	// the call keeps the phase contract even then.
	pi.on("tool_call", async (event) => {
		if (phase !== "planning" && phase !== "executing") return;
		const removed = getPhaseProfile()?.removeTools;
		if (!removed?.includes(event.toolName)) return;
		return {
			block: true,
			reason: `Plannotator: the ${event.toolName} tool is unavailable during the ${phase} phase. Use the workspace tools instead.`,
		};
	});

	// Gate writes during planning — only markdown files inside cwd.
	pi.on("tool_call", async (event, ctx) => {
		if (phase !== "planning") return;
		if (event.toolName !== "write" && event.toolName !== "edit") return;

		const inputPath = event.input.path as string;
		if (!isPlanWritePathAllowed(inputPath, ctx.cwd)) {
			const verb = event.toolName === "write" ? "writes" : "edits";
			return {
				block: true,
				reason: `Plannotator: during planning, ${verb} are limited to markdown files (.md, .mdx) inside the working directory. Blocked: ${inputPath}`,
			};
		}
	});

	// Deliver phase framing once per phase entry, plus per-turn todo status.
	// Plannotator never returns or modifies systemPrompt: Pi's base prompt
	// (AGENTS.md context, skills catalog, tools guidance, user append text) is
	// left untouched, and cache-busting reduces to conversation-suffix appends
	// (#922, approach suggested by Karrq).
	pi.on("before_agent_start", async (_event, ctx) => {
		if (phase !== "planning" && phase !== "executing") {
			// Idle injects nothing (#1269) — with one exception: the first
			// prompt after a planning/executing → idle transition delivers a
			// one-shot plan-mode-off countermand (#1320). Delivered framing
			// stays in history (#1380), so this notice is what ends plan mode:
			// the model's plan-mode turns, blocked-write tool results, and the
			// framing itself keep steering it until the end is said out loud.
			// Cache-wise the notice is free unconditionally — a pure
			// conversation-suffix append on a prefix nothing else perturbs.
			// Fresh idle sessions never arm the latch and inject nothing.
			if (phase !== "idle" || !idleNoticePending) return;
			idleNoticePending = false;
			persistState();
			return {
				message: {
					customType: "plannotator-framing",
					content: PLAN_MODE_OFF_NOTICE,
					display: false,
					details: { phase },
				},
			};
		}

		const profile = getPhaseProfile();
		const planRef = lastSubmittedPath ?? "your plan file";

		if (phase === "executing" && lastSubmittedPath) {
			// Re-read from disk each turn to stay current
			const fullPath = resolve(ctx.cwd, lastSubmittedPath);
			try {
				const planContent = readFileSync(fullPath, "utf-8");
				checklistItems = adoptPlanContent(planContent);
			} catch {
				// File deleted during execution — degrade gracefully
			}
		}

		const todoStats = phase === "executing" ? formatTodoList(checklistItems) : formatTodoList([]);
		// The closing line restates the completion-marker convention so the
		// protocol survives even when compaction has swallowed the framing and
		// re-delivery has not happened yet.
		const todoStatus =
			phase === "executing" && todoStats.remainingCount > 0
				? `[PLANNOTATOR - EXECUTING PLAN]
Todo status for ${planRef}: ${todoStats.completedCount}/${todoStats.totalCount} steps complete.

Remaining steps:
${todoStats.todoList}

Mark completed steps with [DONE:n] in your response.`
				: null;

		if (framingDelivered) {
			// Same phase, later prompt: the framing already sits in conversation
			// history, so inject nothing beyond the small todo snapshot during
			// execution.
			if (!todoStatus) return;
			return {
				message: {
					customType: "plannotator-context",
					content: todoStatus,
					display: false,
				},
			};
		}

		framingDelivered = true;
		persistState();

		if (!profile?.instructions) {
			// Framing explicitly disabled (instructions null/empty): deliver only
			// the todo snapshot during execution, nothing during planning.
			if (!todoStatus) return;
			return {
				message: {
					customType: "plannotator-context",
					content: todoStatus,
					display: false,
				},
			};
		}

		const rendered = renderTemplate(
			profile.instructions,
			buildPromptVariables({
				planFilePath: planRef,
				phase,
				todoList: todoStats.todoList,
				completedCount: todoStats.completedCount,
				totalCount: todoStats.totalCount,
				remainingCount: todoStats.remainingCount,
			}),
		);
		if (rendered.unknownVariables.length > 0) {
			ctx.ui.notify(
				"Plannotator: unknown template variables in " + phase + " instructions: " + rendered.unknownVariables.join(", "),
				"warning",
			);
		}

		let content = rendered.text;
		if (phase === "planning") {
			const hook = readImprovementHook("enterplanmode-improve");
			const pfmEnabled = loadConfig().pfmReminder === true;
			const improveContext = composeImproveContext({
				pfmEnabled,
				improvementHookContent: hook?.content ?? null,
			});
			if (improveContext) content += "\n\n---\n\n" + improveContext;
		}
		// Instructions render an entry-time todo snapshot when they reference
		// ${todoList}; otherwise append the snapshot so the first executing
		// prompt still carries the checklist.
		if (todoStatus && !profile.instructions.includes("${todoList}")) {
			content += "\n\n" + todoStatus;
		}

		return {
			message: {
				customType: "plannotator-framing",
				content,
				display: false,
				details: { phase },
			},
		};
	});

	// There is deliberately NO "context" handler (#1380). One existed here and
	// stripped plannotator-injected messages at phase transitions; Pi applies a
	// context handler's result only to the outgoing LLM request (the runner
	// structuredClones history and transformContext shapes the request in
	// streamAssistantResponse), but the provider's prompt cache keys on the
	// exact request prefix, so removing an already-sent mid-history message
	// shifted every later message and re-billed the whole tail as uncached
	// input (the reporter measured 88 of 119 messages invalidated on one plan
	// completion). The conversation is append-only instead: delivered framing
	// and todo snapshots stay in history for the life of the session, and
	// stale instructions are neutralized by countermands — the executing
	// framing supersedes planning, and PLAN_MODE_OFF_NOTICE supersedes both —
	// which models follow by recency. Compaction remains the one boundary that
	// rewrites history, and it invalidates the provider cache by itself.

	// Track execution progress
	pi.on("message_end", async (event, ctx) => {
		if (phase === "idle" && lastSubmittedPath) {
			// Idle tracking: a plan adopted via plannotator_update_plan (or an
			// earlier run) may have been edited this turn with write/edit —
			// re-read so checkbox flips reflow the live checklist without any
			// phase machinery. Idle still injects nothing into prompts (#1269);
			// this only refreshes the host-state projection and status line.
			try {
				checklistItems = adoptPlanContent(
					readFileSync(resolve(ctx.cwd, lastSubmittedPath), "utf-8"),
				);
			} catch {
				return;
			}
			const idleText = getAssistantMessageText(event.message);
			if (idleText) await persistDoneMarkers(idleText, ctx);
			updateStatus(ctx);
			persistState();
			return;
		}
		if (phase !== "executing" || checklistItems.length === 0) return;

		const text = getAssistantMessageText(event.message);
		if (!text) return;
		if (await persistDoneMarkers(text, ctx) > 0) {
			updateStatus(ctx);
			updateWidget(ctx);
			await syncTodoProvider(ctx);
		}
		persistState();
	});

	// Detect execution completion
	pi.on("agent_end", async (_event, ctx) => {
		if (phase === "executing" && justApprovedPlan) {
			justApprovedPlan = false;
			let attempts = 0;
			const continueWhenIdle = (): void => {
				// This poll outlives the turn that scheduled it, so the session can be
				// replaced or disposed underneath it — print-mode teardown, /new,
				// /reload. Both `ctx` and `pi` are invalidated at that moment and every
				// call on them throws; an uncaught throw inside a timer callback takes
				// the entire pi process down (issue #1140).
				//
				// Cancel rather than retarget: the continuation belongs to the session
				// that approved this plan. A replacement session is a different
				// conversation with no approved plan in it, so nudging it to "continue"
				// would be wrong even though `pi` there is perfectly live.
				if (!sessionAlive || !isCtxAlive(ctx)) return;
				try {
					if (!ctx.isIdle()) {
						attempts += 1;
						if (attempts <= 200) setTimeout(continueWhenIdle, 50);
						return;
					}
					pi.sendUserMessage("Continue with the approved plan.");
				} catch (err) {
					// Lost the race between the liveness probe and the call, or the host
					// failed the send for some other reason. Report, never rethrow.
					if (isCtxAlive(ctx)) {
						console.error(
							`Plannotator: could not continue the approved plan: ${err instanceof Error ? err.message : String(err)}`,
						);
					}
				}
			};
			setTimeout(continueWhenIdle, 0);
			return;
		}

		if (phase !== "executing" || checklistItems.length === 0) return;

		if (checklistItems.every((t) => t.completed)) {
			const completedList = checklistItems
				.map((t) => `- [x] ~~${t.text}~~`)
				.join("\n");
			pi.sendMessage(
				{
					customType: "plannotator-complete",
					content: `**Plan Complete!** ✓\n\n${completedList}`,
					display: true,
				},
				{ triggerTurn: false },
			);
			await returnToIdle(ctx);
		}
	});

	// Restore state on session start/resume
	/**
	 * Re-derive phase, framing latch, and checklist state from the ACTIVE
	 * session path (root to current leaf). Shared by session_start (resume) and
	 * session_tree (branch navigation): a branch switch can land on a path
	 * whose plannotator state differs from memory, or where the delivered
	 * framing message is absent because it lives on another branch.
	 */
	async function resyncPhaseFromSession(
		ctx: ExtensionContext,
		options: { phaseWhenUnrecorded: Phase; warnOnPlanning: boolean },
	): Promise<void> {
		const entries = ctx.sessionManager.getBranch();
		const stateEntry = entries
			.filter(
				(e: { type: string; customType?: string }) =>
					e.type === "custom" && e.customType === "plannotator",
			)
			.pop() as { data?: PersistedPlannotatorState } | undefined;

		if (stateEntry?.data) {
			phase = stateEntry.data.phase ?? options.phaseWhenUnrecorded;
			lastSubmittedPath = stateEntry.data.lastSubmittedPath ?? lastSubmittedPath;
			savedState = stateEntry.data.savedState ?? savedState;
			phaseAddedTools = stateEntry.data.phaseAddedTools ?? phaseAddedTools;
			// The framing message persists in the restored conversation history,
			// so a resumed phase must not deliver it again. A path recorded
			// before delivery restores the latch open and re-delivers.
			framingDelivered = stateEntry.data.framingDelivered ?? false;
			// Same contract for the plan-mode-off notice: a path that recorded
			// the transition but not yet the delivery still owes it; a path
			// that recorded the delivery must not repeat it.
			idleNoticePending = stateEntry.data.idleNoticePending ?? false;
			reviewPending = stateEntry.data.reviewPending ?? false;
		} else {
			// No plannotator activity on this path. Memory savedState and
			// phaseAddedTools are kept so the idle branch below can hand back
			// tools and settings a now-abandoned branch's phase had taken.
			phase = options.phaseWhenUnrecorded;
			framingDelivered = false;
			// A path with no plannotator state never had plan mode, so no
			// countermand is owed — and injecting one here would break the
			// #1269 fresh-session inject-nothing promise.
			idleNoticePending = false;
			reviewPending = false;
		}

		if (phase === "planning" && !savedState) {
			captureSavedState(ctx);
		}

		// Rebuild execution state from disk + session messages
		if (phase === "executing") {
			if (lastSubmittedPath) {
				const fullPath = resolve(ctx.cwd, lastSubmittedPath);
				if (existsSync(fullPath)) {
					const content = readFileSync(fullPath, "utf-8");
					checklistItems = adoptPlanContent(content);

					// Find last execution marker and scan messages after it for [DONE:n]
					let executeIndex = -1;
					for (let i = entries.length - 1; i >= 0; i--) {
						const entry = entries[i] as { type: string; customType?: string };
						if (entry.customType === "plannotator-execute") {
							executeIndex = i;
							break;
						}
					}

					const recoveredMarkers: string[] = [];
					for (let i = executeIndex + 1; i < entries.length; i++) {
						const entry = entries[i];
						if (entry.type === "message" && "message" in entry) {
							const text = getAssistantMessageText(entry.message);
							if (text) recoveredMarkers.push(text);
						}
					}
					if (recoveredMarkers.length > 0) {
						await persistDoneMarkers(recoveredMarkers.join("\n"), ctx);
					}
				} else {
					// Plan file gone — fall back to idle. This demotes a RECORDED
					// executing phase, so the session provably used plan mode and
					// its framing residue is still in history: owe the countermand.
					// Arming here cannot break the #1269 fresh-session promise —
					// only a persisted executing entry reaches this branch.
					phase = "idle";
					lastSubmittedPath = null;
					idleNoticePending = true;
				}
			} else {
				// No path recorded — can't rebuild, fall back to idle. Same
				// recorded-executing demotion as above: the countermand is owed.
				phase = "idle";
				idleNoticePending = true;
			}
		}

		if (phase === "planning") {
			checklistItems = [];
			if (options.warnOnPlanning) {
				const warning = getPlanReviewAvailabilityWarning({ hasUI: ctx.hasUI });
				if (warning) {
					ctx.ui.notify(warning, "warning");
				}
			}
		}

		if (phase === "idle") {
			releaseAddedPhaseTools();
			if (savedState) {
				await restoreSavedState(ctx);
				savedState = null;
			}
			// Jingler fork: the submit/update tools are deliberately NOT stripped
			// here — the plan scratchpad rides in every mode, and idle sessions
			// may submit a plan for review whenever the agent judges it needs
			// operator sign-off.
		} else if (phase === "planning" || phase === "executing") {
			await applyPhaseConfig(ctx, { restoreSavedState: true });
		}

		updateStatus(ctx);
		updateWidget(ctx);
		persistState();
	}

	pi.on("session_start", async (_event, ctx) => {
		// Project trust gate (#1291). Capability absent = fail closed: the
		// project-local config is skipped and the honest capability warning
		// fires (see PROJECT_TRUST_CAPABILITY_WARNING). A host that provides
		// the function is honored verbatim — including one that hardcodes
		// `true` because it has no project-trust gate by policy (oh-my-pi's
		// planned shim). A throwing trustFn (real Pi throws on a stale
		// context) propagates deliberately: config loading never runs, so
		// project-local config still cannot load.
		const trustFn = ctx.isProjectTrusted as (() => boolean) | undefined;
		const projectTrusted = typeof trustFn === "function" ? trustFn.call(ctx) : false;
		if (typeof trustFn !== "function") {
			ctx.ui.notify(PROJECT_TRUST_CAPABILITY_WARNING, "warning");
		}
		const loadedConfig = loadPlannotatorConfig(ctx.cwd, {
			projectTrusted,
		});
		plannotatorConfig = loadedConfig.config;
		for (const warning of loadedConfig.warnings) {
			ctx.ui.notify(`Plannotator config: ${warning}`, "warning");
		}

		// Check --plan flag
		if (pi.getFlag("plan") === true) {
			phase = "planning";
		}

		await resyncPhaseFromSession(ctx, { phaseWhenUnrecorded: phase, warnOnPlanning: true });
		void resumePendingPlanReview(ctx).catch((error: unknown) => {
			const message = `Cannot resume plan review: ${error instanceof Error ? error.message : String(error)}`;
			ctx.ui.notify(message, "error");
			publishHostNotice(message);
		});
	});

	// Compaction summarizes conversation history and can swallow the delivered
	// framing message (custom messages are ordinary compactable messages), so
	// reopen the latch: the next prompt re-delivers the phase framing. If the
	// framing survived in the kept tail, re-delivery duplicates it — accepted
	// (#1380): the copies are identical instructions, the newest governs, and
	// compaction already invalidated the cached prefix, so appending a fresh
	// copy costs nothing while removing the survivor would cost the cache.
	pi.on("session_compact", async () => {
		if (phase !== "planning" && phase !== "executing") return;
		framingDelivered = false;
		persistState();
	});

	// A /tree branch switch changes the active path out from under the latch:
	// the new path can carry different phase state, or lack the framing message
	// that was delivered on the abandoned branch. Re-derive everything from the
	// new path; a path with no plannotator state at all means idle.
	pi.on("session_tree", async (_event, ctx) => {
		await resyncPhaseFromSession(ctx, { phaseWhenUnrecorded: "idle", warnOnPlanning: false });
	});
}
