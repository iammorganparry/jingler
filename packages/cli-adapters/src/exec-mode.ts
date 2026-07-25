import type { PermissionMode } from "@starbase/core"

/**
 * Which permission mode a chat runs in around a plan.
 *
 * Plan mode is a detour: the operator leaves whatever they were running in,
 * plans, and on approval must land back where they were. Two rules govern that,
 * and both exist because of a specific bug — which is why they are here, stated
 * once and tested, rather than inline at the two places that need them.
 */

/** The safe floor when nothing else is known. */
export const FALLBACK_EXEC_MODE: PermissionMode = "accept-edits"

/**
 * The mode to remember when ENTERING plan mode, so approval can restore it.
 *
 * `current` is what the chat is running in right now (in-memory, else persisted).
 * A session started directly in plan mode has no such thing, so the harness
 * config default stands in.
 *
 * Guards against remembering "plan" itself: re-entering plan mode from plan mode
 * would otherwise record it as the thing to restore, and approval would leave the
 * chat in plan mode forever, unable to execute what it just approved.
 */
export const modeToRestore = (
  current: PermissionMode | undefined,
  configDefault: PermissionMode | undefined
): PermissionMode =>
  current !== undefined && current !== "plan"
    ? current
    : configDefault ?? FALLBACK_EXEC_MODE

/**
 * The mode to run in when a plan is APPROVED, in strict precedence order.
 *
 * 1. `explicit` — the operator picked a mode as they approved. Their say-so wins.
 * 2. `prior` — what they were actually running in before planning. This is their
 *    real intent for the session.
 * 3. `configDefault` — the harness config file's default.
 * 4. `accept-edits`.
 *
 * The order of 2 and 3 is load-bearing and was once wrong. `configDefault` is
 * "accept-edits" for anyone who has not set one, so letting it win would silently
 * override the "auto" the operator chose in the composer and re-gate every single
 * command of the execution they just approved.
 */
export const modeOnApproval = (options: {
  readonly explicit?: PermissionMode | undefined
  readonly prior?: PermissionMode | undefined
  readonly configDefault?: PermissionMode | undefined
}): PermissionMode =>
  options.explicit ?? options.prior ?? options.configDefault ?? FALLBACK_EXEC_MODE
