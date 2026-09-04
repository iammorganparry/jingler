import type { ExtensionContext, SessionEntry, SessionMessageEntry } from "@earendil-works/pi-coding-agent";

export type LastAssistantMessageSnapshot = {
	entryId: string;
	text: string;
};

export type RecentAssistantMessage = {
	messageId: string;
	text: string;
	timestamp?: string;
};

export function getAssistantMessageText(
	message: SessionMessageEntry["message"],
): string | null {
	if (message.role !== "assistant") return null;
	const text = message.content
		.filter((block) => block.type === "text")
		.map((block) => block.text)
		.join("\n");
	return text.trim() ? text : null;
}

function getCurrentBranch(ctx: ExtensionContext): SessionEntry[] {
	return ctx.sessionManager.getBranch();
}

export function getLastAssistantMessageSnapshot(ctx: ExtensionContext): LastAssistantMessageSnapshot | null {
	// "Last" means the active conversation branch, not the newest message anywhere
	// in the append-only session file.
	const branch = getCurrentBranch(ctx);
	for (let i = branch.length - 1; i >= 0; i--) {
		const entry = branch[i];
		if (entry.type === "message" && entry.message) {
			const text = getAssistantMessageText(entry.message);
			if (text) return { entryId: entry.id, text };
		}
	}
	return null;
}

export function getLastAssistantMessageText(ctx: ExtensionContext): string | null {
	return getLastAssistantMessageSnapshot(ctx)?.text ?? null;
}

export function findAssistantMessageByEntryId(
	ctx: ExtensionContext,
	entryId: string,
): LastAssistantMessageSnapshot | null {
	const branch = getCurrentBranch(ctx);
	for (const entry of branch) {
		if (entry.id !== entryId || entry.type !== "message" || !entry.message) continue;
		const text = getAssistantMessageText(entry.message);
		if (text) return { entryId: entry.id, text };
	}
	return null;
}

export function getRecentAssistantMessages(
	ctx: ExtensionContext,
	limit: number,
): RecentAssistantMessage[] {
	const branch = getCurrentBranch(ctx);
	const out: RecentAssistantMessage[] = [];
	for (let i = branch.length - 1; i >= 0 && out.length < limit; i--) {
		const entry = branch[i];
		if (entry.type !== "message" || !entry.message) continue;
		const text = getAssistantMessageText(entry.message);
		if (!text) continue;
		out.push({ messageId: entry.id, text, timestamp: entry.timestamp });
	}
	return out;
}

export function hasSessionMovedPastEntry(ctx: ExtensionContext, entryId: string): boolean {
	if (!ctx.isIdle()) return true;

	const branch = getCurrentBranch(ctx);
	const index = branch.findIndex((entry) => entry.id === entryId);
	if (index === -1) return true;

	return branch.slice(index + 1).some((entry) => entry.type === "message");
}
