import type { Message, Session } from "@jingler/core"
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
import type { AgentRuntimeShape } from "./runtime/agent/agent-runtime.js"
import { runReadOnlyRoleText } from "./runtime/agent/read-only-role.js"
import { SessionStore, taskSlug } from "./sessions.js"
import { GitService } from "./git.js"
import { TranscriptStore } from "./transcripts.js"

/**
 * Auto-titling: name a session from its transcript and refresh it each turn. The
 * LLM call is isolated behind a `TitleGenerator` seam so `retitleSession` (and its
 * tests) stay deterministic; the live generator folds every failure to a
 * first-message heuristic, so titling never throws and never blocks.
 */

/** A hung provider request can't wedge the retitle — bound the one-shot call. */
const TITLE_TIMEOUT = "15 seconds"

/** Pluggable title source — the injection point for deterministic tests. */
export interface TitleGenerator {
  readonly generate: (
    messages: ReadonlyArray<Message>,
    session: Session
  ) => Effect.Effect<SessionMetadataProposal>
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

/**
 * Live generator: a fresh, read-only title role through the same canonical pi
 * runtime and explicit provider connection as the conversation. Missing runtime
 * identity, provider failures, and timeouts fold to the deterministic fallback.
 */
export const makeAgentRuntimeTitleGenerator = (
  runtime: AgentRuntimeShape
): TitleGenerator => ({
  generate: (messages, session) => {
    if (messages.length === 0) {
      return Effect.succeed(fallbackMetadata(messages))
    }

    return runReadOnlyRoleText(
      runtime,
      session,
      "title",
      buildTitlePrompt(messages),
      TITLE_TIMEOUT
    ).pipe(
      Effect.map((text) => parseSessionMetadata(text, messages)),
      Effect.orElseSucceed(() => fallbackMetadata(messages))
    )
  }
})

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
    return yield* retitleEligibleSession(session, gen, sessionId)
  }).pipe(
    Effect.catchTag("SessionNotFoundError", () => Effect.fail(new GitError({ message: "Session not found" })))
  )

function* retitleEligibleSession(session: Session, gen: TitleGenerator, sessionId: string) {
  if (session.autoTitle !== true && session.semanticBranchPending !== true) return session
  // Transcripts are owned by chats, not sessions. Legacy session-keyed
  // transcripts are adopted into activeChatId when the session is loaded, so
  // reading by sessionId here silently misses every modern turn.
  return yield* proposeSessionMetadata(session, gen, sessionId)
}

function* proposeSessionMetadata(session: Session, gen: TitleGenerator, sessionId: string) {
  const messages = yield* TranscriptStore.list(session.activeChatId).pipe(
      Effect.orElseSucceed(() => [])
    )
    const proposal = yield* gen.generate(messages, session)
    // An empty transcript (a run-start trigger can beat the first write) yields
    // only the "Untitled session" heuristic — never let that displace the
    // session's provisional creative title.
    const title =
      session.autoTitle === true && messages.length > 0 ? proposal.title : session.title
  // A direct session never owns a task branch. Retitling still updates its
  // display name, but branch creation belongs exclusively to linked worktrees.
  return yield* applySessionMetadata(session, title, sessionId, messages, proposal)
}

function* applySessionMetadata(
  session: Session,
  title: string,
  sessionId: string,
  messages: ReadonlyArray<Message>,
  proposal: SessionMetadataProposal
) {
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
    return yield* reconcileExistingTaskBranch(title,
      session,
          liveBranch,
          persistedProposal,
      sessionId
    )
  }

    // An auto-named session with no transcript yet has nothing meaningful to
    // seed a branch from — keep the pending marker so the next trigger (plan,
    // completion) names it from real content instead of the creative
    // placeholder.
    if (messages.length === 0 && session.autoTitle === true) return { ...session, title }

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
  }

function* reconcileExistingTaskBranch(
  title: string,
  session: Session,
  liveBranch: string,
  persistedProposal: Session["semanticBranchProposal"],
  sessionId: string
) {
  if (
    title !== session.title ||
    liveBranch !== session.branch ||
    session.semanticBranchPending === true ||
    (session.semanticBranchProposal === undefined && persistedProposal !== undefined)
  ) {
    yield* SessionStore.setTitleAndBranch(sessionId, title, liveBranch, persistedProposal)
  }
  return {
    ...session,
    title,
    branch: liveBranch,
    ...(persistedProposal === undefined ? {} : { semanticBranchProposal: persistedProposal }),
    semanticBranchPending: false
  }
}
