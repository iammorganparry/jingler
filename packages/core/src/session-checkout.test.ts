import { describe, expect, it } from "vitest";
import {
  activeCheckoutOf,
  agentCwdOf,
  checkoutsOf,
  hasNoRepo,
  migrateSessionCheckouts,
  ownedWorktreePaths,
  PRIMARY_CHECKOUT_ID,
  reduceCheckouts,
} from "./session-checkout.js";
import type { SessionCheckout } from "./domain.js";

const legacy: Parameters<typeof checkoutsOf>[0] = {
  id: "s1",
  repo: "api",
  repoPath: "/r/api",
  worktreePath: "/w/api",
  branch: "feat/a",
  baseBranch: "main",
  prNumber: null,
};

const web: SessionCheckout = {
  id: "co-web",
  repo: "web",
  repoPath: "/r/web",
  worktreePath: "/w/web",
  workspaceMode: "worktree",
  branch: "feat/b",
  baseBranch: "main",
  prNumber: 7,
};

describe("legacy migration", () => {
  it("reads a scalar-only session as one checkout and persists it idempotently", () => {
    const { id: _sessionId, checkouts: _c, activeCheckoutId: _a, ...scalars } = legacy;
    expect(checkoutsOf(legacy)).toEqual([{ ...scalars, id: PRIMARY_CHECKOUT_ID }]);
    const migrated = migrateSessionCheckouts(legacy);
    expect(migrated.checkouts).toHaveLength(1);
    expect(migrated.activeCheckoutId).toBe(PRIMARY_CHECKOUT_ID);
    expect(migrateSessionCheckouts(migrated)).toBe(migrated);
  });
});

describe("checkout reducer", () => {
  it("attach activates the new checkout and mirrors its scalars", () => {
    const s = reduceCheckouts(legacy, { type: "attach", checkout: web });
    expect(s.checkouts).toHaveLength(2);
    expect(s).toMatchObject({ activeCheckoutId: "co-web", repo: "web", worktreePath: "/w/web", branch: "feat/b", prNumber: 7 });
  });

  it("switching back and re-attaching an existing repo never duplicates a worktree", () => {
    let s = reduceCheckouts(legacy, { type: "attach", checkout: web });
    s = reduceCheckouts(s, { type: "switch", checkoutId: PRIMARY_CHECKOUT_ID });
    expect(s).toMatchObject({ repo: "api", worktreePath: "/w/api", prNumber: null });
    s = reduceCheckouts(s, { type: "attach", checkout: { ...web, id: "co-dup", worktreePath: "/w/dup" } });
    expect(s.checkouts).toHaveLength(2);
    expect(s.activeCheckoutId).toBe("co-web");
    expect(s.worktreePath).toBe("/w/web");
  });

  it("update mirrors only when the checkout is active", () => {
    const s = reduceCheckouts(legacy, { type: "attach", checkout: web });
    const other = reduceCheckouts(s, { type: "update", checkoutId: PRIMARY_CHECKOUT_ID, patch: { prNumber: 3 } });
    expect(other.prNumber).toBe(7);
    expect(checkoutsOf(other)[0]?.prNumber).toBe(3);
    expect(reduceCheckouts(s, { type: "update", checkoutId: "co-web", patch: { prNumber: 9 } }).prNumber).toBe(9);
  });

  it("detach removes owned worktrees and falls back to a remaining checkout", () => {
    const s = reduceCheckouts(legacy, { type: "attach", checkout: web });
    expect(ownedWorktreePaths(s)).toEqual(["/w/api", "/w/web"]);
    const d = reduceCheckouts(s, { type: "detach", checkoutId: "co-web" });
    expect(d).toMatchObject({ activeCheckoutId: PRIMARY_CHECKOUT_ID, repo: "api" });
    expect(ownedWorktreePaths(d)).toEqual(["/w/api"]);
    expect(reduceCheckouts(d, { type: "detach", checkoutId: PRIMARY_CHECKOUT_ID }).checkouts).toHaveLength(1);
    expect(activeCheckoutOf(d).id).toBe(PRIMARY_CHECKOUT_ID);
  });

  it("direct-mode checkouts are not owned worktrees", () => {
    expect(ownedWorktreePaths({ ...legacy, workspaceMode: "direct" })).toEqual([]);
  });
});

describe("Auto (zero-checkout) sessions", () => {
  const auto: Parameters<typeof checkoutsOf>[0] = {
    id: "s-auto",
    repo: "",
    branch: "",
    prNumber: null,
    checkouts: [],
  };

  it("has no repoPath/worktreePath on its placeholder checkout", () => {
    const checkout = activeCheckoutOf(auto);
    expect(checkout.repoPath).toBeUndefined();
    expect(checkout.worktreePath).toBeUndefined();
  });

  it("hasNoRepo is true only for the placeholder checkout, false once a real repo is attached", () => {
    expect(hasNoRepo(activeCheckoutOf(auto))).toBe(true);
    expect(hasNoRepo(activeCheckoutOf(legacy))).toBe(false);
    const attached = reduceCheckouts(auto, { type: "attach", checkout: web });
    expect(hasNoRepo(activeCheckoutOf(attached))).toBe(false);
  });

  it("agentCwdOf falls back to the scratch folder with no checkouts, and to the checkout once attached", () => {
    expect(agentCwdOf(auto, "/scratch/s-auto")).toBe("/scratch/s-auto");
    const attached = reduceCheckouts(auto, { type: "attach", checkout: web });
    expect(agentCwdOf(attached, "/scratch/s-auto")).toBe("/w/web");
    // attaching drops the placeholder, leaving only the real checkout
    expect(attached.checkouts).toHaveLength(1);
  });

  it("agentCwdOf prefers a legacy session's worktree/repo over the scratch fallback", () => {
    expect(agentCwdOf(legacy, "/scratch/s1")).toBe("/w/api");
  });
});
