import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { GitService, GitHubApi, SessionStore } from "@jingler/cli-adapters";
import {
  failureOf,
  initGitRepoWithOrigin,
  mkTemp,
  runExit,
  withTempRoot,
} from "@jingler/cli-adapters/test-support";
import { Effect, Layer } from "effect";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { appendStackedPr, githubRestack } from "./rpc.js";

const now = "2026-10-11T10:00:00.000Z";
const git = (cwd: string, args: ReadonlyArray<string>) =>
  execFileSync("git", args, { cwd, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const commitFile = (cwd: string, file: string, content: string, message: string) => {
  writeFileSync(join(cwd, file), content);
  git(cwd, ["add", file]);
  git(cwd, ["commit", "-m", message, "--no-gpg-sign"]);
};

type Layer_ = { number: number; branch: string; base: string };

describe("stacked PR create + Github.restack", () => {
  let temp: ReturnType<typeof withTempRoot>;
  let repos: ReturnType<typeof mkTemp>;
  let clone: string;
  let origin: string;
  const setBaseCalls: Array<{ number: number; base: string }> = [];

  const fakeGithub = Layer.succeed(GitHubApi, {
    repository: () => Effect.succeed({ fullName: "acme/widget" }),
    prSetBase: (_cwd: string, number: number, base: string) =>
      Effect.sync(() => void setBaseCalls.push({ number, base })),
  } as never);
  const services = Layer.mergeAll(SessionStore.Default, GitService.Default, fakeGithub);

  const writeSession = (layers: ReadonlyArray<Layer_>, worktreePath = clone) => {
    mkdirSync(temp.root, { recursive: true });
    writeFileSync(
      join(temp.root, "sessions.json"),
      JSON.stringify([
        {
          id: "s1",
          repo: "widget",
          branch: layers.at(-1)?.branch ?? "feat/a",
          baseBranch: "main",
          worktreePath,
          title: "Stack",
          status: "idle",
          diff: { added: 0, removed: 0 },
          prNumber: layers.at(-1)?.number ?? null,
          prs: layers,
          costUsd: 0,
          tokens: 0,
          updatedAt: now,
          chats: [{ id: "c1", title: null, createdAt: now, updatedAt: now }],
          activeChatId: "c1",
        },
      ]),
    );
  };

  /** main <- a (PR 11) <- b (PR 12) <- c (PR 13); every branch pushed. */
  const buildStack = (names: ReadonlyArray<string>) => {
    for (const [i, name] of names.entries()) {
      git(clone, ["switch", "-c", `feat/${name}`, ...(i === 0 ? ["main"] : [`feat/${names[i - 1]}`])]);
      commitFile(clone, `${name}.txt`, `${name}\n`, `add ${name}`);
      git(clone, ["push", "origin", `feat/${name}`]);
    }
    git(clone, ["switch", "main"]);
  };
  /** Squash-merge `a` into main on the remote only, like GitHub does. */
  const squashMergeA = (aContent = "a\n") => {
    commitFile(clone, "a.txt", aContent, "squash a");
    git(clone, ["push", "origin", "main"]);
  };
  const remote = (args: ReadonlyArray<string>) => git(origin, args);

  const run = <A, E>(effect: Effect.Effect<A, E, never>) =>
    runExit(effect, Layer.mergeAll(temp.layer, services) as never);

  beforeEach(() => {
    setBaseCalls.length = 0;
    temp = withTempRoot();
    repos = mkTemp("jingler-restack-");
    clone = join(repos.dir, "widget");
    ({ origin } = initGitRepoWithOrigin(clone));
  });
  afterEach(() => {
    temp.cleanup();
    repos.cleanup();
  });

  it("appends a PR created on a stack layer's head branch, in order", async () => {
    writeSession([{ number: 11, branch: "feat/a", base: "main" }]);
    const exit = await run(
      Effect.gen(function* () {
        const stacked = yield* appendStackedPr("s1", { number: 12, branch: "feat/b", base: "feat/a" });
        const unrelated = yield* appendStackedPr("s1", { number: 99, branch: "feat/x", base: "release" });
        return { stacked, unrelated, session: yield* SessionStore.get("s1") };
      }) as never,
    );
    expect(exit._tag).toBe("Success");
    if (exit._tag !== "Success") return;
    const { stacked, unrelated, session } = exit.value as {
      stacked: boolean; unrelated: boolean; session: { prs: Array<{ number: number }>; prNumber: number };
    };
    expect(stacked).toBe(true);
    expect(unrelated).toBe(false);
    expect(session.prs.map((pr) => pr.number)).toEqual([11, 12]);
    expect(session.prNumber).toBe(12);
  });

  it("retargets the next layer, rebases every layer above, and updates the stored stack", async () => {
    buildStack(["a", "b", "c"]);
    squashMergeA();
    writeSession([
      { number: 11, branch: "feat/a", base: "main" },
      { number: 12, branch: "feat/b", base: "feat/a" },
      { number: 13, branch: "feat/c", base: "feat/b" },
    ]);
    const bBefore = remote(["rev-parse", "feat/b"]);

    const exit = await run(
      Effect.gen(function* () {
        const restacked = yield* githubRestack({ sessionId: "s1", mergedPr: 11 });
        return { restacked, session: yield* SessionStore.get("s1") };
      }) as never,
    );
    expect(exit._tag).toBe("Success");
    if (exit._tag !== "Success") return;
    const { restacked, session } = exit.value as {
      restacked: Array<Layer_>; session: { prs: Array<{ number: number; base?: string; state?: string }> };
    };

    expect(restacked).toEqual([
      { number: 12, branch: "feat/b", base: "main" },
      { number: 13, branch: "feat/c", base: "feat/b" },
    ]);
    // Only the layer directly above the merged one changes its PR base.
    expect(setBaseCalls).toEqual([{ number: 12, base: "main" }]);
    expect(remote(["rev-parse", "feat/b"])).not.toBe(bBefore);
    expect(remote(["log", "--format=%s", "feat/c"]).split("\n")).toEqual(["add c", "add b", "squash a", "init"]);
    expect(session.prs.find((pr) => pr.number === 11)?.state).toBe("merged");
    expect(session.prs.find((pr) => pr.number === 12)?.base).toBe("main");
    expect(session.prs.find((pr) => pr.number === 13)?.base).toBe("feat/b");
  });

  it("is a no-op when nothing sits above the merged layer", async () => {
    buildStack(["a"]);
    writeSession([{ number: 11, branch: "feat/a", base: "main" }]);
    const before = remote(["rev-parse", "feat/a"]);
    const exit = await run(githubRestack({ sessionId: "s1", mergedPr: 11 }) as never);
    expect(exit._tag).toBe("Success");
    if (exit._tag === "Success") expect(exit.value).toEqual([]);
    expect(setBaseCalls).toEqual([]);
    expect(remote(["rev-parse", "feat/a"])).toBe(before);
  });

  it("fails with a typed conflict error carrying the paths and leaves the remote untouched", async () => {
    git(clone, ["switch", "-c", "feat/a", "main"]);
    commitFile(clone, "a.txt", "a\n", "add a");
    git(clone, ["push", "origin", "feat/a"]);
    git(clone, ["switch", "-c", "feat/b"]);
    commitFile(clone, "a.txt", "a edited by b\n", "edit a in b");
    git(clone, ["push", "origin", "feat/b"]);
    git(clone, ["switch", "main"]);
    squashMergeA("a squashed differently\n");
    writeSession([
      { number: 11, branch: "feat/a", base: "main" },
      { number: 12, branch: "feat/b", base: "feat/a" },
    ]);
    const bBefore = remote(["rev-parse", "feat/b"]);

    const exit = await run(githubRestack({ sessionId: "s1", mergedPr: 11 }) as never);
    const failure = failureOf(exit as never) as { _tag: string; paths: ReadonlyArray<string>; branch: string } | undefined;
    expect(failure?._tag).toBe("RestackConflictError");
    expect(failure?.paths).toEqual(["a.txt"]);
    expect(failure?.branch).toBe("feat/b");
    expect(setBaseCalls).toEqual([]);
    expect(remote(["rev-parse", "feat/b"])).toBe(bBefore);
  });
});
