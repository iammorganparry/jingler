import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import { Session } from "./domain.js";
import {
  activeCheckoutOf,
  agentCwdOf,
  checkoutsOf,
  hasNoRepo,
  migrateCheckoutPrs,
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

const wire = () => ({
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
});

describe("Session wire format", () => {

  it("decodes legacy scalars into a primary checkout and strips them", () => {
    const session = Schema.decodeUnknownSync(Session)(wire());
    expect(activeCheckoutOf(session)).toMatchObject({ id: PRIMARY_CHECKOUT_ID, repo: "api", worktreePath: "/w/api", baseBranch: "main" });
    expect(session).not.toHaveProperty("repo");
    expect(session).not.toHaveProperty("worktreePath");
  });

  it("encodes the active checkout back to top-level fields for older readers", () => {
    const session = reduceCheckouts(Schema.decodeUnknownSync(Session)(wire()), { type: "attach", checkout: web });
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

describe("checkout PRs", () => {
  it("migrates session prs onto checkouts", () => {
    const legacyWire = {
      id: "s1",
      checkouts: [{ ...web, id: "co-api", repo: "api", prNumber: null }, web],
      activeCheckoutId: "co-web",
      prs: [{ number: 3, repo: "api", state: "open" as const }, { number: 7, repo: "web" }, { number: 11 }],
    };
    const migrated = migrateCheckoutPrs(legacyWire);
    expect(checkoutsOf(migrated).map((c) => [c.id, c.prs, c.prNumber])).toEqual([
      ["co-api", [{ number: 3, state: "open" }, { number: 11 }], 11],
      ["co-web", [{ number: 7 }], 7],
    ]);
    expect(migrateCheckoutPrs(migrated)).toBe(migrated);
  });

  it("round-trips through the wire with repo-tagged session prs and the active top as prNumber", () => {
    const session = reduceCheckouts(
      Schema.decodeUnknownSync(Session)({ ...wire(), prNumber: 5 }),
      { type: "attach", checkout: web },
    );
    expect(session).not.toHaveProperty("prs");
    const encoded = Schema.encodeSync(Session)(session);
    expect(encoded.prNumber).toBe(7);
    expect(encoded.prs).toEqual([{ number: 5, repo: "api" }, { number: 7, repo: "web" }]);
    expect(checkoutsOf(Schema.decodeUnknownSync(Session)(encoded)).map((c) => c.prNumber)).toEqual([5, 7]);
  });
});

describe("checkout publish", () => {
  it("moves a wire publish onto the active checkout and mirrors it back", () => {
    const publish = { step: "failed" as const, completed: [], updatedAt: "2026-07-11T10:00:00.000Z" };
    const session = Schema.decodeUnknownSync(Session)({ ...wire(), publish });
    expect(session).not.toHaveProperty("publish");
    expect(activeCheckoutOf(session).publish).toEqual(publish);
    expect(Schema.encodeSync(Session)(session).publish).toEqual(publish);
  });
});

describe("reposLabelOf", () => {
  it("names one repo, every repo once a second is attached, and No repo for Auto", () => {
    expect(reposLabelOf(legacy)).toBe("api");
    expect(reposLabelOf(reduceCheckouts(legacy, { type: "attach", checkout: { ...web, repo: "org/web" } }))).toBe("api + web");
    expect(reposLabelOf({ id: "s-auto", repo: "", branch: "", prNumber: null, checkouts: [] })).toBe("No repo");
  });
});
