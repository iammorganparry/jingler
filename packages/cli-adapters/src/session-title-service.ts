import type { Message } from "@jingler/core"
import {
  GitError,
  buildTitlePrompt,
  cleanSemanticBranchProposal,
  cleanTitle,
  fallbackTitle,
  semanticBranchName,
  semanticBranchProposalFromName,
  type SessionMetadataProposal,
  workspaceModeOf
} from "@jingler/core"
import { Effect } from "effect"
import { SessionStore, taskSlug } from "./sessions.js"
import { GitService } from "./git.js"
import { TranscriptStore } from "./transcripts.js"
import { isScriptedEnv } from "./scripted.js"

/**
 * Auto-titling: name a session from its transcript and refresh it each turn. The
 * LLM call is isolated behind a `TitleGenerator` seam so `retitleSession` (and its
 * tests) stay deterministic; the live generator folds every failure to a
 * first-message heuristic, so titling never throws and never blocks.
 */

/** A hung `claude` login can't wedge the retitle — bound the one-shot call. */
const TITLE_TIMEOUT = "15 seconds"
/** Cheap/fast model for titling regardless of the session's coding model. */
const TITLE_MODEL = "haiku"

/** Pluggable title source — the injection point for deterministic tests. */
export interface TitleGenerator {
  readonly generate: (messages: ReadonlyArray<Message>) => Effect.Effect<SessionMetadataProposal>
}

const fallbackMetadata = (messages: ReadonlyArray<Message>): SessionMetadataProposal => {
  const title = fallbackTitle(messages)
  return { title, branch: cleanSemanticBranchProposal(null, title) }
}

/** Decode the one-shot model response without trusting either ref component. */
export const parseSessionMetadata = (
  raw: string,
  messages: ReadonlyArray<Message>
): SessionMetadataProposal => {
  const fallback = fallbackMetadata(messages)
  try {
    const unfenced = raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "")
    const decoded = JSON.parse(unfenced) as {
      title?: unknown
      branch?: { type?: unknown; slug?: unknown }
    }
    const title = typeof decoded.title === "string" ? cleanTitle(decoded.title) : fallback.title
    return {
      title: title === "Untitled session" ? fallback.title : title,
      // An invalid branch falls back from the actual request, never from other
      // model-controlled prose such as its proposed display title.
      branch: cleanSemanticBranchProposal(decoded.branch, fallback.title)
    }
  } catch {
    return fallback
  }
}

/** Concatenated text of an SDK assistant message's `text` content blocks. */
const assistantText = (msg: unknown): string => {
  const content = (msg as { message?: { content?: unknown } }).message?.content
  if (!Array.isArray(content)) return ""
  return content
    .filter((b) => (b as { type?: unknown }).type === "text")
    .map((b) => String((b as { text?: unknown }).text ?? ""))
    .join(" ")
}

/**
 * Live generator: a one-shot Haiku completion via the Claude Agent SDK, which
 * runs on the user's `claude` subscription login (no API key required) and works
 * for both claude and codex sessions. Any error/timeout/empty output folds to the
 * deterministic `fallbackTitle` — so a user without a Claude login still gets a
 * sensible name from their first message.
 */
export const claudeTitleGenerator: TitleGenerator = {
  generate: (messages) =>
    messages.length === 0 || isScriptedEnv()
      ? Effect.succeed(fallbackMetadata(messages))
      : Effect.tryPromise(async () => {
          const { query } = await import("@anthropic-ai/claude-agent-sdk")
          const iterator = query({
            prompt: buildTitlePrompt(messages),
            options: { model: TITLE_MODEL, allowedTools: [], maxTurns: 1, includePartialMessages: false }
          })
          let text = ""
          for await (const m of iterator) {
            if ((m as { type?: string }).type === "assistant") text += assistantText(m)
            if ((m as { type?: string }).type === "result") break
          }
          return text
        }).pipe(
          Effect.timeout(TITLE_TIMEOUT),
          Effect.map((t) => parseSessionMetadata(t, messages)),
          Effect.orElseSucceed(() => fallbackMetadata(messages))
        )
}

/**
 * Regenerate a session's title from its transcript and persist it, returning the
 * updated record. A pinned session (`autoTitle === false`, set by a manual
 * rename) is left untouched with no LLM call. The first generated title also
 * names a detached session's branch; established branches are never renamed.
 */
export const retitleSession = (sessionId: string, gen: TitleGenerator) =>
  Effect.gen(function* () {
    const session = yield* SessionStore.get(sessionId)
    // Only auto-named sessions are retitled. `autoTitle` absent ⇒ the session was
    // named by the user (legacy/explicit) and is left pinned.
    if (session.autoTitle !== true && session.semanticBranchPending !== true) return session
    const messages = yield* TranscriptStore.list(sessionId).pipe(Effect.orElseSucceed(() => []))
    const proposal = yield* gen.generate(messages)
    const title = session.autoTitle === true ? proposal.title : session.title
    // A direct session never owns a task branch. Retitling still updates its
    // display name, but branch creation belongs exclusively to linked worktrees.
    if (workspaceModeOf(session) === "direct") {
      if (title !== session.title) yield* SessionStore.setTitle(sessionId, title)
      return { ...session, title }
    }
    if (!session.worktreePath) {
      if (title !== session.title) yield* SessionStore.setTitle(sessionId, title)
      return { ...session, title }
    }

    const liveBranch = yield* GitService.branchAt(session.worktreePath)
    if (liveBranch !== null) {
      // A process can stop after `git switch -c` and before sessions.json is
      // updated. Recover the proposal from the canonical live ref in that case;
      // later title refreshes preserve the original proposal instead of making
      // it drift away from the branch Jingler actually created.
      const persistedProposal = session.semanticBranchProposal ??
        semanticBranchProposalFromName(liveBranch) ??
        undefined
      if (title !== session.title ||
        liveBranch !== session.branch ||
        session.semanticBranchPending === true ||
        (session.semanticBranchProposal === undefined && persistedProposal !== undefined)) {
        yield* SessionStore.setTitleAndBranch(
          sessionId,
          title,
          liveBranch,
          persistedProposal
        )
      }
      return {
        ...session,
        title,
        branch: liveBranch,
        ...(persistedProposal === undefined ? {} : { semanticBranchProposal: persistedProposal }),
        semanticBranchPending: false
      }
    }

    // A completion signal can beat transcript persistence by a few milliseconds.
    // For a pinned task, its operator-supplied title is still a meaningful,
    // deterministic seed; do not immortalise `chore/untitled-session` and clear
    // the pending marker before the transcript arrives.
    const safeProposal = session.semanticBranchProposal ??
      (messages.length === 0
        ? cleanSemanticBranchProposal(null, taskSlug(title))
        : cleanSemanticBranchProposal(proposal.branch, taskSlug(title)))
    if (session.semanticBranchProposal === undefined) {
      yield* SessionStore.setSemanticBranchProposal(sessionId, safeProposal)
    }
    const branch = yield* GitService.createTaskBranch(
      session.worktreePath,
      semanticBranchName(safeProposal)
    )
    yield* SessionStore.setTitleAndBranch(sessionId, title, branch, safeProposal)
    return {
      ...session,
      title,
      branch,
      semanticBranchProposal: safeProposal,
      semanticBranchPending: false
    }
  }).pipe(
    Effect.catchTag("SessionNotFoundError", () => Effect.fail(new GitError({ message: "Session not found" })))
  )
