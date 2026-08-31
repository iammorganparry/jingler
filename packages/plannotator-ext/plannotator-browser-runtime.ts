import { readFileSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

type PlannotatorBrowserModule = typeof import("./plannotator-browser.ts");

const moduleDirectory = dirname(fileURLToPath(import.meta.url));
const planHtmlPath = resolve(moduleDirectory, "plannotator.html");

let browserModulePromise: Promise<PlannotatorBrowserModule> | undefined;
let planHtmlContent: string | undefined;

function hasReadableAsset(path: string, cachedContent: string | undefined): boolean {
	if (cachedContent) return true;
	try {
		const stats = statSync(path);
		return stats.isFile() && stats.size > 0;
	} catch {
		return false;
	}
}

function readBrowserAsset(path: string, cachedContent: string | undefined): string {
	if (cachedContent !== undefined) return cachedContent;
	try {
		return readFileSync(path, "utf-8");
	} catch {
		return "";
	}
}

/** Return whether the built plan/annotation/archive UI is available without reading it into memory. */
export function hasPlanBrowserHtml(): boolean {
	return hasReadableAsset(planHtmlPath, planHtmlContent);
}

/** Read and cache the built plan/annotation/archive UI on first use. */
export function getPlanBrowserHtml(): string {
	const content = readBrowserAsset(planHtmlPath, planHtmlContent);
	if (content) planHtmlContent = content;
	return content;
}

/** Convert a startup failure into the stable user-facing message used by Pi commands and events. */
export function getStartupErrorMessage(error: unknown): string {
	return error instanceof Error ? error.message : "Unknown error";
}

/**
 * Load the browser/server graph on first use.
 *
 * Concurrent callers share one import, while a failed import is cleared so a
 * later invocation can retry instead of retaining a permanently rejected promise.
 */
export function loadPlannotatorBrowser(): Promise<PlannotatorBrowserModule> {
	if (!browserModulePromise) {
		browserModulePromise = import("./plannotator-browser.ts").catch((error: unknown) => {
			browserModulePromise = undefined;
			throw error;
		});
	}
	return browserModulePromise;
}
