import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import { Session } from "./domain.js";
import {
  activeCheckoutOf,
  agentCwdOf,
  checkoutsOf,
  hasNoRepo,
  migrateSessionCheckouts,
  ownedWorktreePaths,
  PRIMARY_CHECKOUT_ID,
  reduceCheckouts,
  reposLabelOf,
  sessionForCheckout,
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

describe("Session wire format", () => {
  const wire = {
    id: "s1",
    repo: "api",
    repoPath: "/r/api",
    worktreePath: "/w/api",
    branch: "feat/a",
    baseBranch: "main",
    title: "t",
    status: "idle",
    diff: { added: 0, removed: 0 },
    prNumber: null,
    costUsd: 0,
    tokens: 0,
    updatedAt: "2026-07-11T10:00:00.000Z",
    chats: [{ id: "c1", title: null, createdAt: "2026-07-11T10:00:00.000Z", updatedAt: "2026-07-11T10:00:00.000Z" }],
    activeChatId: "c1",
  };

  it("decodes legacy scalars into a primary checkout and strips them", () => {
    const session = Schema.decodeUnknownSync(Session)(wire);
    expect(activeCheckoutOf(session)).toMatchObject({ id: PRIMARY_CHECKOUT_ID, repo: "api", worktreePath: "/w/api", baseBranch: "main" });
    expect(session).not.toHaveProperty("repo");
    expect(session).not.toHaveProperty("worktreePath");
  });

  it("encodes the active checkout back to top-level fields for older readers", () => {
    const session = reduceCheckouts(Schema.decodeUnknownSync(Session)(wire), { type: "attach", checkout: web });
    const encoded = Schema.encodeSync(Session)(session);
    expect(encoded).toMatchObject({ repo: "web", worktreePath: "/w/web", branch: "feat/b", activeCheckoutId: "co-web" });
    expect(Schema.decodeUnknownSync(Session)(encoded).checkouts).toHaveLength(2);
  });
});

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

  it("a view through a non-active checkout resolves that checkout", () => {
    const s = reduceCheckouts(legacy, { type: "attach", checkout: web });
    const view = sessionForCheckout(s, PRIMARY_CHECKOUT_ID);
    expect(activeCheckoutOf(view).id).toBe(PRIMARY_CHECKOUT_ID);
    expect(view).toMatchObject({ repo: "api", worktreePath: "/w/api" });
    expect(sessionForCheckout(s, "co-web")).toBe(s);
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

describe("reposLabelOf", () => {
  it("names one repo, every repo once a second is attached, and No repo for Auto", () => {
    expect(reposLabelOf(legacy)).toBe("api");
    expect(reposLabelOf(reduceCheckouts(legacy, { type: "attach", checkout: { ...web, repo: "org/web" } }))).toBe("api + web");
    expect(reposLabelOf({ id: "s-auto", repo: "", branch: "", prNumber: null, checkouts: [] })).toBe("No repo");
  });
});
