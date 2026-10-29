import type { Session, SessionCheckout } from "./domain.js";

/** Id of the implicit checkout built from a legacy session's scalar fields. */
export const PRIMARY_CHECKOUT_ID = "primary";

/** Legacy per-session copies of the active checkout; optional so the helpers never depend on them. */
type CheckoutScalars = Omit<SessionCheckout, "id">;

// Structural, not `Pick<Session, …>`: `Session`'s schema calls these helpers, so referencing it here is a type cycle.
type CheckoutSession = Partial<CheckoutScalars> & {
  readonly id: string;
  readonly checkouts?: ReadonlyArray<SessionCheckout>;
  readonly activeCheckoutId?: string;
};

const defined = <T extends object>(value: T): T =>
  Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as T;

/** The scalar `Session` fields a checkout mirrors while it is active. */
const scalarsOf = (checkout: SessionCheckout): CheckoutScalars => ({
  projectId: checkout.projectId,
  repo: checkout.repo,
  repoPath: checkout.repoPath,
  worktreePath: checkout.worktreePath,
  workspaceMode: checkout.workspaceMode,
  branch: checkout.branch,
  baseBranch: checkout.baseBranch,
  prNumber: checkout.prNumber,
  githubSlug: checkout.githubSlug,
});

const legacyCheckoutOf = (session: Partial<CheckoutScalars>): SessionCheckout =>
  defined({
    id: PRIMARY_CHECKOUT_ID,
    projectId: session.projectId,
    repo: session.repo ?? "",
    repoPath: session.repoPath,
    worktreePath: session.worktreePath,
    workspaceMode: session.workspaceMode,
    branch: session.branch ?? "",
    baseBranch: session.baseBranch,
    prNumber: session.prNumber ?? null,
    githubSlug: session.githubSlug,
  });

/**
 * A legacy OR Auto session (no `checkouts`, or an empty array — an Auto
 * session that has not yet `switch_checkout`ed into a repo) reads as exactly
 * one checkout built from its scalars. For Auto those scalars are blank
 * (`repoPath`/`worktreePath` absent, `repo`/`branch` empty strings), so this
 * is a placeholder checkout with nowhere to run — `agentCwdOf` below falls
 * back to the session's scratch folder for exactly that case.
 */
export const checkoutsOf = (session: CheckoutSession): ReadonlyArray<SessionCheckout> =>
  session.checkouts && session.checkouts.length > 0 ? session.checkouts : [legacyCheckoutOf(session)];

export const activeCheckoutOf = (session: CheckoutSession): SessionCheckout => {
  const all = checkoutsOf(session);
  return all.find((c) => c.id === session.activeCheckoutId) ?? all[0] ?? legacyCheckoutOf(session);
};

/** Fill `checkouts`/`activeCheckoutId` on a legacy session; a no-op once migrated. */
export const migrateSessionCheckouts = <S extends CheckoutSession>(session: S): S =>
  session.checkouts && session.checkouts.length > 0
    ? session
    : { ...session, checkouts: [legacyCheckoutOf(session)], activeCheckoutId: PRIMARY_CHECKOUT_ID };

/** Directory the agent's tools run in: the active checkout's worktree/repo, else the session's scratch folder. */
export const agentCwdOf = (session: CheckoutSession, scratchDir: string): string => {
  const active = activeCheckoutOf(session);
  return active.worktreePath ?? active.repoPath ?? scratchDir;
};

/**
 * True for the Auto placeholder checkout: no `repoPath`, so there is nowhere
 * running `git` would resolve to. Once `switch_checkout` attaches a real
 * checkout (which always carries `repoPath`), this is false again.
 */
export const hasNoRepo = (checkout: Pick<SessionCheckout, "repo" | "repoPath">): boolean =>
  checkout.repoPath === undefined && checkout.repo === "";

/** Every attached repo's name ("api + web"), "No repo" for an Auto session that has none yet. */
export const reposLabelOf = (session: CheckoutSession): string => {
  const real = checkoutsOf(session).filter((c) => !hasNoRepo(c));
  if (real.length === 0) return "No repo";
  return real.map((c) => c.repo.split("/").filter(Boolean).at(-1) ?? c.repo).join(" + ");
};

export type CheckoutAction =
  /** Attach a checkout and make it active; an existing one for the same repo is re-activated, never duplicated. */
  | { readonly type: "attach"; readonly checkout: SessionCheckout }
  | { readonly type: "switch"; readonly checkoutId: string }
  | { readonly type: "update"; readonly checkoutId: string; readonly patch: Partial<Omit<SessionCheckout, "id">> }
  /** Drop a checkout (its worktree is cleaned up by the caller). The last one cannot be removed. */
  | { readonly type: "detach"; readonly checkoutId: string };

const withActive = <S extends CheckoutSession>(
  session: S,
  checkouts: ReadonlyArray<SessionCheckout>,
  activeId: string,
): S => {
  const active = checkouts.find((c) => c.id === activeId) ?? checkouts[0];
  if (!active) return session;
  return { ...session, ...scalarsOf(active), checkouts, activeCheckoutId: active.id };
};

const sameRepo = (a: SessionCheckout, b: SessionCheckout): boolean =>
  a.repoPath !== undefined && a.repoPath === b.repoPath;

/** Pure checkout reducer; the scalar mirrors always follow the active checkout. */
export const reduceCheckouts = <S extends CheckoutSession>(session: S, action: CheckoutAction): S => {
  const migrated = migrateSessionCheckouts(session);
  const checkouts = checkoutsOf(migrated);
  const activeId = activeCheckoutOf(migrated).id;
  switch (action.type) {
    case "attach": {
      const existing = checkouts.find((c) => sameRepo(c, action.checkout));
      if (existing) return withActive(migrated, checkouts, existing.id);
      // Drop the Auto placeholder (no `repoPath`, synthesized from blank
      // scalars by `checkoutsOf`) once a real checkout is attached — it was
      // never a repo the session worked in, just the absence of one.
      const real = checkouts.filter((c) => c.repoPath !== undefined);
      return withActive(migrated, [...real, action.checkout], action.checkout.id);
    }
    case "switch":
      return checkouts.some((c) => c.id === action.checkoutId)
        ? withActive(migrated, checkouts, action.checkoutId)
        : migrated;
    case "update":
      return withActive(
        migrated,
        checkouts.map((c) => (c.id === action.checkoutId ? { ...c, ...action.patch } : c)),
        activeId,
      );
    case "detach":
      return checkouts.length <= 1
        ? migrated
        : withActive(migrated, checkouts.filter((c) => c.id !== action.checkoutId), activeId);
  }
};

/** Worktrees Jingler owns for this session — all must be removed on archive/delete. */
export const ownedWorktreePaths = (session: CheckoutSession): ReadonlyArray<string> =>
  checkoutsOf(session).flatMap((c) =>
    c.workspaceMode !== "direct" && c.worktreePath !== undefined ? [c.worktreePath] : [],
  );

/** One checkout by id; falls back to the active one when `checkoutId` is absent or unknown. */
export const checkoutById = (session: CheckoutSession, checkoutId?: string): SessionCheckout =>
  (checkoutId === undefined ? undefined : checkoutsOf(session).find((c) => c.id === checkoutId)) ??
  activeCheckoutOf(session);

/**
 * The session as seen through one checkout: its scalar fields mirror that
 * checkout. The active checkout returns the session itself, so legacy callers
 * see no change.
 */
export const sessionForCheckout = <S extends CheckoutSession>(session: S, checkoutId: string): S => {
  const checkout = checkoutById(session, checkoutId);
  return checkout.id === activeCheckoutOf(session).id
    ? session
    : { ...session, ...scalarsOf(checkout), activeCheckoutId: checkout.id };
};
