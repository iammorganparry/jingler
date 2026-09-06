import type {
  GitHubAppConnectionStatus,
  GitHubAppInstallation,
} from "@jingler/core";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";

export interface FakeGitHubPr {
  readonly number: number;
  readonly title: string;
  readonly headRefName: string;
  readonly baseRefName: string;
  readonly author: { readonly login: string };
  readonly state?: string;
  readonly isDraft?: boolean;
  readonly additions?: number;
  readonly deletions?: number;
  readonly updatedAt?: string;
  readonly body?: string;
  readonly labels?: ReadonlyArray<{
    readonly name: string;
    readonly color?: string;
  }>;
  readonly mergeStateStatus?: string;
  readonly checks?: ReadonlyArray<{
    readonly name: string;
    readonly conclusion?: string;
    readonly status?: string;
    readonly detailsUrl?: string;
  }>;
  readonly headRepository?: {
    readonly id?: number;
    readonly fullName: string;
    readonly cloneUrl?: string;
    readonly sshUrl?: string | null;
  };
}

export interface FakeGitHubIssue {
  readonly number: number;
  readonly title: string;
  readonly url?: string;
  readonly body?: string;
  readonly labels?: ReadonlyArray<{
    readonly name: string;
    readonly color?: string;
  }>;
  readonly author: { readonly login: string };
  readonly assignees?: ReadonlyArray<{ readonly login: string }>;
  readonly updatedAt?: string;
}

export interface FakeGitHubOptions {
  readonly connected?: boolean;
  readonly userLogin?: string;
  readonly accountLogin?: string;
  readonly repositorySelection?: "all" | "selected";
  readonly selectedRepositories?: ReadonlyArray<{
    readonly id: string;
    readonly fullName: string;
  }>;
  readonly suspended?: boolean;
  readonly prs?: ReadonlyArray<FakeGitHubPr>;
  readonly issues?: ReadonlyArray<FakeGitHubIssue>;
  readonly diff?: string;
  /** Local checkout used as the API-resolved head remote in fork/session tests. */
  readonly cloneUrl?: string;
  /** WebSocket relay origin returned by the short-lived desktop grant. */
  readonly relayUrl?: string;
  readonly relayGrant?: string;
}

export interface FakeGitHubServer {
  readonly url: string;
  /** Sanitized request metadata: credentials and bodies are deliberately absent. */
  readonly requests: ReadonlyArray<{ method: string; path: string }>;
  /** Semantic write operations for assertions such as selected merge method. */
  readonly operations: ReadonlyArray<string>;
  /** Requested installation permissions, excluding the repository qualifier. */
  readonly credentialRequests: ReadonlyArray<{
    readonly repository: string;
    readonly permissions: ReadonlyArray<string>;
  }>;
  readonly connect: () => void;
  readonly setInstallation: (patch: Partial<GitHubAppInstallation>) => void;
  readonly addPr: (pr: FakeGitHubPr) => void;
  readonly sessionRoute: (sessionId: string) => {
    readonly relaySessionId: string;
    readonly pullRequestNumber: number;
    readonly state: "active" | "archived";
  } | null;
  /** Fail exactly the next matching mutation, then recover for retry/restart tests. */
  readonly failNext: (operation: "create-pr" | "update-pr") => void;
  readonly status: () => GitHubAppConnectionStatus;
  readonly publishedPr: () => {
    readonly number: number;
    readonly title: string;
    readonly body: string;
    readonly head: string;
    readonly base: string;
  } | null;
  readonly close: () => Promise<void>;
}

const rateHeaders = {
  "x-ratelimit-limit": "5000",
  "x-ratelimit-remaining": "4999",
  "x-ratelimit-used": "1",
  "x-ratelimit-reset": "1893456000",
};

const json = (res: ServerResponse, status: number, body: unknown): void => {
  res.writeHead(status, {
    "content-type": "application/json",
    "cache-control": "no-store",
    ...rateHeaders,
  });
  res.end(JSON.stringify(body));
};

const text = (res: ServerResponse, status: number, body: string): void => {
  res.writeHead(status, {
    "content-type": "text/plain; charset=utf-8",
    "cache-control": "no-store",
    ...rateHeaders,
  });
  res.end(body);
};

const requestBody = async (
  req: IncomingMessage,
): Promise<Record<string, unknown>> => {
  const chunks: Buffer[] = [];
  for await (const chunk of req)
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  if (chunks.length === 0) return {};
  try {
    const value: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    return value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
};

const page = <A>(rows: ReadonlyArray<A>, url: URL): ReadonlyArray<A> => {
  const pageNumber = Number(url.searchParams.get("page") ?? "1");
  const perPage = Number(url.searchParams.get("per_page") ?? "100");
  const start = Math.max(0, pageNumber - 1) * perPage;
  return rows.slice(start, start + perPage);
};

/** Stateful, offline implementation of both desktop GitHub routes and the relay. */
export const startFakeGitHubServer = async (
  token: string,
  options: FakeGitHubOptions = {},
): Promise<FakeGitHubServer> => {
  let connected = options.connected ?? false;
  let lastRefreshedAt: string | null = connected
    ? "2026-08-04T09:00:00.000Z"
    : null;
  let installation: GitHubAppInstallation = {
    id: "101",
    account: {
      id: "201",
      login: options.accountLogin ?? "acme",
      type: "Organization",
      avatarUrl: null,
    },
    repositorySelection: options.repositorySelection ?? "all",
    ...((options.repositorySelection ?? "all") === "selected"
      ? {
          repositories: [
            ...(options.selectedRepositories ?? [
              {
                id: "301",
                fullName: `${options.accountLogin ?? "acme"}/widget`,
              },
            ]),
          ],
        }
      : {}),
    permissions: {
      contents: "write",
      pull_requests: "write",
      issues: "write",
      checks: "read",
      statuses: "read",
      workflows: "write",
    },
    status: options.suspended ? "suspended" : "active",
    suspendedAt: options.suspended ? "2026-08-04T08:00:00.000Z" : null,
  };
  const prs = [...(options.prs ?? [])];
  const issues = [...(options.issues ?? [])];
  const requests: Array<{ method: string; path: string }> = [];
  const operations: string[] = [];
  const credentialRequests: Array<{
    repository: string;
    permissions: ReadonlyArray<string>;
  }> = [];
  const installationTokens = new Map<string, ReadonlySet<string>>();
  let installationTokenNumber = 0;
  const sessionRoutes = new Map<
    string,
    {
      sessionId: string;
      relaySessionId: string;
      installationId: string;
      repositoryId: string;
      pullRequestNumber: number;
      state: "active" | "archived";
      updatedAt: string;
    }
  >();
  const failures = new Set<"create-pr" | "update-pr">();
  const grant = options.relayGrant ?? "e2e-short-lived-github-grant";
  let publishedPr: PublishedPull | null = null;

  const status = (): GitHubAppConnectionStatus => ({
    enabled: true,
    connected,
    user: connected
      ? {
          id: "1",
          login: options.userLogin ?? "octocat",
          name: "Octo Cat",
          avatarUrl: null,
        }
      : null,
    installations: connected ? [installation] : [],
    lastRefreshedAt,
  });

  const pullJson = (pr: FakeGitHubPr) => {
    return {
      id: 10_000 + pr.number,
      node_id: `PR_${pr.number}`,
      number: pr.number,
      ...pullStateFields(pr),
      draft: pr.isDraft ?? false,
      title: pr.title,
      body: pr.body ?? "",
      html_url: `https://github.com/acme/widget/pull/${pr.number}`,
      user: { login: pr.author.login, avatar_url: null },
      head: {
        ref: pr.headRefName,
        sha: `e2ehead${pr.number}`,
        repo: pullHeadRepository(pr, installation.account.login, options.cloneUrl),
      },
      base: { ref: pr.baseRefName },
      created_at: pr.updatedAt ?? "2026-07-11T00:00:00Z",
      updated_at: pr.updatedAt ?? "2026-07-11T00:00:00Z",
      commits: 1,
      changed_files: 1,
      additions: pr.additions ?? 0,
      deletions: pr.deletions ?? 0,
      labels: (pr.labels ?? []).map((label) => ({
        name: label.name,
        color: label.color ?? "cccccc",
      })),
      mergeable: pr.mergeStateStatus === "DIRTY" ? false : true,
      merge_state_status: pr.mergeStateStatus ?? "CLEAN",
    };
  };

  const issueJson = (issue: FakeGitHubIssue) => ({
    id: 20_000 + issue.number,
    number: issue.number,
    title: issue.title,
    html_url:
      issue.url ?? `https://github.com/acme/widget/issues/${issue.number}`,
    state: "open",
    body: issue.body ?? "",
    user: { login: issue.author.login, avatar_url: null },
    assignees: (issue.assignees ?? []).map((assignee) => ({
      login: assignee.login,
      avatar_url: null,
    })),
    labels: (issue.labels ?? []).map((label) => ({
      name: label.name,
      color: label.color ?? "cccccc",
    })),
    created_at: issue.updatedAt ?? "2026-07-11T00:00:00Z",
    updated_at: issue.updatedAt ?? "2026-07-11T00:00:00Z",
  });

  let server!: Server;
  const handleHostedRequest = async (req: IncomingMessage, res: ServerResponse, requestUrl: URL, method: string) => {
    if (req.headers.authorization !== `Bearer ${token}`) {
      json(res, 401, { error: "Authentication required" });
      return;
    }

    const sessionRouteMatch = requestUrl.pathname.match(
      /^\/api\/github\/session-routes\/([^/]+)(\/archive)?$/,
    );

    const routes = [
      {
        matches: () => (requestUrl.pathname === "/api/github/status" && method === "GET"),
        handle: function githubStatus() {
          json(res, 200, status());
          return;
        }
      },
      {
        matches: () => (requestUrl.pathname === "/api/github/repositories" && method === "GET"),
        handle: function githubRepositories() {
          const repositories = installation.repositories ?? [
            { id: "301", fullName: `${installation.account.login}/widget` },
          ];
          json(res, 200, {
            repositories: connected && installation.status === "active"
              ? repositories.map((repository) => ({
                installationId: installation.id,
                repositoryId: repository.id,
                fullName: repository.fullName,
              }))
              : [],
          });
          return;
        }
      },
      {
        matches: () => (requestUrl.pathname === "/api/github/install" && method === "GET"),
        handle: function githubInstall() {
          const address = server.address() as AddressInfo;
          json(res, 200, {
            url: `http://127.0.0.1:${address.port}/browser/install`,
            expiresAt: "2099-01-01T00:00:00.000Z",
          });
          return;
        }
      },
      {
        matches: () => (requestUrl.pathname === "/api/github/refresh" &&
          method === "POST"),
        handle: function githubRefresh() {
          lastRefreshedAt = new Date(
            Date.parse(lastRefreshedAt ?? "2026-08-04T09:00:00.000Z") + 1_000,
          ).toISOString();
          json(res, 200, status());
          return;
        }
      },
      {
        matches: () => (requestUrl.pathname === "/api/github/disconnect" &&
          method === "POST"),
        handle: function githubDisconnect() {
          connected = false;
          lastRefreshedAt = null;
          res.writeHead(204, { "cache-control": "no-store" }).end();
          return;
        }
      },
      {
        matches: () => (requestUrl.pathname === "/api/github/session-routes" &&
          method === "GET"),
        handle: function listSessionRoutes() {
          json(res, 200, { routes: [...sessionRoutes.values()] });
          return;
        }
      },
      {
        matches: () => (requestUrl.pathname === "/api/github/session-routes" &&
          method === "POST"),
        handle: async function registerSessionRoute() {
          const body = await requestBody(req);
          const sessionId = String(body.sessionId ?? "");
          const installationId = String(body.installationId ?? "");
          const repositoryId = String(body.repositoryId ?? "");
          const pullRequestNumber = Number(body.pullRequestNumber);
          if (
            !connected ||
            !sessionId ||
            installationId !== installation.id ||
            repositoryId !== "301" ||
            !Number.isSafeInteger(pullRequestNumber)
          ) {
            json(res, 403, { error: "Session route is not accessible" });
            return;
          }
          const existing = sessionRoutes.get(sessionId);
          const identityChanged =
            existing !== undefined &&
            (existing.installationId !== installationId ||
              existing.repositoryId !== repositoryId ||
              existing.pullRequestNumber !== pullRequestNumber);
          const route = {
            sessionId,
            relaySessionId: identityChanged
              ? `relay-${sessionId}-${pullRequestNumber}`
              : (existing?.relaySessionId ?? `relay-${sessionId}`),
            installationId,
            repositoryId,
            pullRequestNumber,
            state: "active" as const,
            updatedAt: new Date().toISOString(),
          };
          sessionRoutes.set(sessionId, route);
          json(res, 200, { route });
          return;
        }
      },
      {
        matches: () => (requestUrl.pathname === "/api/github/session-grant" &&
          method === "POST"),
        handle: async function grantSession() {
          const body = await requestBody(req);
          const relaySessionId = String(body.relaySessionId ?? "");
          const route = [...sessionRoutes.values()].find(
            (candidate) =>
              candidate.relaySessionId === relaySessionId &&
              candidate.state === "active",
          );
          if (!connected || !route) {
            json(res, 403, { error: "Active session route required" });
            return;
          }
          json(res, 200, {
            relayUrl:
              options.relayUrl ??
              `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
            grant: `${grant}:${relaySessionId}`,
            claims: {
              version: 1,
              issuer: "jingler",
              audience: "jingler-github-relay",
              subject: "e2e-user",
              installationId: route.installationId,
              relaySessionId,
              issuedAt: 1_786_000_000,
              expiresAt: 4_070_908_800,
              grantId: `e2e-${relaySessionId}`,
            },
          });
          return;
        }
      },
      {
        matches: () => (sessionRouteMatch &&
          method === "POST" &&
          sessionRouteMatch![2] === "/archive"),
        handle: function archiveSessionRoute() {
          const relaySessionId = decodeURIComponent(sessionRouteMatch![1]!);
          const route = [...sessionRoutes.values()].find(
            (candidate) => candidate.relaySessionId === relaySessionId,
          );
          if (route)
            sessionRoutes.set(route.sessionId, { ...route, state: "archived" });
          res.writeHead(204, { "cache-control": "no-store" }).end();
          return;
        }
      },
      {
        matches: () => (sessionRouteMatch && method === "DELETE" && !sessionRouteMatch![2]),
        handle: function deleteSessionRoute() {
          const relaySessionId = decodeURIComponent(sessionRouteMatch![1]!);
          const route = [...sessionRoutes.values()].find(
            (candidate) => candidate.relaySessionId === relaySessionId,
          );
          if (route) sessionRoutes.delete(route.sessionId);
          res.writeHead(204, { "cache-control": "no-store" }).end();
          return;
        }
      },
      {
        matches: () => (requestUrl.pathname === "/api/github/desktop-grant" &&
          method === "POST"),
        handle: async function grantDesktop() {
          const body = await requestBody(req);
          if (!connected || installation.status === "suspended") {
            json(res, 403, { error: "Active installation required" });
            return;
          }
          const installationId = String(body.installationId ?? "");
          if (installationId !== installation.id) {
            json(res, 403, { error: "Installation is not accessible" });
            return;
          }
          json(res, 200, {
            relayUrl:
              options.relayUrl ??
              `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
            grant,
            claims: {
              version: 1,
              issuer: "jingler",
              audience: "jingler-github-relay",
              subject: "e2e-user",
              installationId,
              issuedAt: 1_786_000_000,
              expiresAt: 4_070_908_800,
              grantId: "e2e-grant-id",
            },
          });
          return;
        }
      },
      {
        matches: () => (requestUrl.pathname === "/api/github/installation-credentials" &&
          method === "POST"),
        handle: async function installationCredentials() {
          const body = await requestBody(req);
          const installationId = String(body.installationId ?? "");
          if (
            !connected ||
            installation.status === "suspended" ||
            installationId !== installation.id
          ) {
            json(res, 403, {
              error: "Active accessible installation required",
            });
            return;
          }
          const scopes = credentialScopes(body.scopes);
          const repositoryScope = scopes.find((scope) =>
            scope.startsWith("repository:"),
          );
          const repository = repositoryScope?.slice("repository:".length) ?? "";
          const permissions = scopes.filter(
            (scope) => !scope.startsWith("repository:"),
          );
          const installed = installation.permissions;
          const selectedRepositoryAvailable =
            installation.repositorySelection === "all" ||
            (installation.repositories ?? []).some(
              (candidate) =>
                candidate.fullName.toLowerCase() === repository.toLowerCase(),
            );
          const supported = permissions.every((scope) => {
            const [name, level] = scope.split(":");
            const available = name ? installed[name] : undefined;
            return level === "read"
              ? available === "read" || available === "write"
              : level === "write" && available === "write";
          });
          if (
            repository.toLowerCase() !==
            `${installation.account.login}/widget`.toLowerCase() ||
            !selectedRepositoryAvailable ||
            permissions.length === 0 ||
            !supported
          ) {
            json(res, 403, {
              error: "Incorrect repository or installation permissions",
            });
            return;
          }
          credentialRequests.push({ repository, permissions });
          installationTokenNumber += 1;
          const installationToken = `e2e-installation-token-${installationTokenNumber}`;
          installationTokens.set(installationToken, new Set(permissions));
          json(res, 200, {
            token: installationToken,
            installationId,
            expiresAt: "2099-01-01T00:00:00.000Z",
          });
          return;
        }
      },
      {
        matches: () => (requestUrl.pathname === "/api/github/pull-requests" &&
          method === "POST"),
        handle: async function createHostedPull() {
          const body = await requestBody(req);
          const installationId = String(body.installationId ?? "");
          const repository = String(body.repository ?? "");
          if (
            !connected ||
            installation.status === "suspended" ||
            installationId !== installation.id ||
            repository.toLowerCase() !==
            `${installation.account.login}/widget`.toLowerCase()
          ) {
            json(res, 403, { error: "Repository is not accessible" });
            return;
          }
          if (failures.delete("create-pr")) {
            operations.push("fail create-pr");
            json(res, 503, {
              error: "Injected pull request creation failure",
            });
            return;
          }
          operations.push(`pr create ${String(body.head ?? "")}`);
          publishedPr = publishedPull(body);
          const headRefName = publishedHeadName(publishedPr.head);
          prs.push({
            number: 900,
            title: publishedPr.title,
            body: publishedPr.body,
            headRefName,
            baseRefName: publishedPr.base,
            author: { login: options.userLogin ?? "octocat" },
          });
          json(res, 201, { number: 900 });
          return;
        }
      }
    ];
    const route = routes.find((candidate) => candidate.matches());
    if (route) return route.handle();

    json(res, 404, { error: "Not found" });
    return;
  };

  const handleRequest = async (req: IncomingMessage, res: ServerResponse) => {
    const requestUrl = new URL(req.url ?? "/", "http://127.0.0.1");
    const method = req.method ?? "GET";
    requests.push({ method, path: requestUrl.pathname });

    if (requestUrl.pathname === "/browser/install") {
      res.writeHead(200, { "content-type": "text/html" });
      res.end(
        "<!doctype html><title>Fake GitHub App</title><p>Installation ready.</p>",
      );
      return;
    }

    if (requestUrl.pathname.startsWith("/api/github/")) {
      return handleHostedRequest(req, res, requestUrl, method);
    }

    const grantedPermissions = authenticateInstallation(req, res, installationTokens, connected, installation);
    if (grantedPermissions === null) return;

    const hasPermission = (required: string): boolean => {
      const [name, level] = required.split(":");
      if (!name || !level) return false;
      return (
        grantedPermissions.has(required) ||
        (level === "read" && grantedPermissions.has(`${name}:write`))
      );
    };
    const requirePermissions = (
      ...required: ReadonlyArray<string>
    ): boolean => {
      if (required.every(hasPermission)) return true;
      json(res, 403, { message: "Resource not accessible by integration" });
      return false;
    };
    if (requestUrl.pathname === "/graphql" && method === "POST") {
      return handleGraphql(req, res, requirePermissions, operations);
    }

    const repository = repositoryRequest(requestUrl, installation, res);
    if (repository === null) return;
    const { owner, repo, suffix } = repository;
    const pullMatch = /^\/pulls\/(\d+)(.*)$/.exec(suffix);

    const checksMatch = /^\/commits\/([^/]+)\/check-runs$/.exec(suffix);

    const issueMatch = /^\/issues\/(\d+)(.*)$/.exec(suffix);

    const routes = [
      {
        matches: () => (suffix === "" && method === "GET"),
        handle: function readRepository() {
          if (!requirePermissions("contents:read")) return;
          json(res, 200, {
            id: 301,
            node_id: "R_widget",
            name: repo,
            full_name: `${owner}/${repo}`,
            private: true,
          });
          return;
        }
      },
      {
        matches: () => (suffix === "/pulls" && method === "GET"),
        handle: function listPullRequests() {
          if (!requirePermissions("pull_requests:read")) return;
          json(res, 200, page(prs.map(pullJson), requestUrl));
          return;
        }
      },
      {
        matches: () => (suffix === "/pulls" && method === "POST"),
        handle: async function createPullRequest() {
          if (!requirePermissions("pull_requests:write")) return;
          if (failures.delete("create-pr")) {
            operations.push("fail create-pr");
            json(res, 503, { message: "Injected pull request creation failure" });
            return;
          }
          const body = await requestBody(req);
          operations.push(`pr create ${String(body.head ?? "")}`);
          publishedPr = {
            number: 900,
            title: String(body.title ?? ""),
            body: String(body.body ?? ""),
            head: String(body.head ?? ""),
            base: String(body.base ?? ""),
          };
          const headRefName = publishedPr.head.includes(":")
            ? publishedPr.head.slice(publishedPr.head.indexOf(":") + 1)
            : publishedPr.head;
          prs.push({
            number: 900,
            title: publishedPr.title,
            body: publishedPr.body,
            // GitHub accepts an owner-qualified create payload but returns the
            // branch-only ref alongside its repository identity.
            headRefName,
            baseRefName: publishedPr.base,
            author: { login: options.userLogin ?? "octocat" },
          });
          json(res, 201, { number: 900 });
          return;
        }
      },
      {
        matches: () => (pullMatch),
        handle: async function routePullRequest() {
          const number = Number(pullMatch![1]);
          const tail = pullMatch![2] ?? "";
          const pr = prs.find((candidate) => candidate.number === number);
          if (!pr) {
            json(res, 404, { message: "Not Found" });
            return;
          }

          const replyMatch = /^\/comments\/(\d+)\/replies$/.exec(tail);

          const routes = [
            {
              matches: () => (tail === "" && method === "GET"),
              handle: function readPull() {
                if (!requirePermissions("pull_requests:read")) return;
                if (
                  String(req.headers.accept ?? "").includes(
                    "application/vnd.github.diff",
                  )
                ) {
                  text(
                    res,
                    200,
                    options.diff ??
                    "diff --git a/src/auth.ts b/src/auth.ts\n--- a/src/auth.ts\n+++ b/src/auth.ts\n@@ -1 +1,2 @@\n one\n+two\n",
                  );
                } else {
                  json(res, 200, pullJson(pr));
                }
                return;
              }
            },
            {
              matches: () => (tail === "" && method === "PATCH"),
              handle: async function updatePull() {
                if (!requirePermissions("pull_requests:write")) return;
                if (failures.delete("update-pr")) {
                  operations.push("fail update-pr");
                  json(res, 503, { message: "Injected pull request update failure" });
                  return;
                }
                const body = await requestBody(req);
                publishedPr = updatePublishedPull(publishedPr, number, body);
                operations.push(`pr update ${number}`);
                json(
                  res,
                  200,
                  pullJson({
                    ...pr,
                    title: String(body.title ?? pr.title),
                    body: String(body.body ?? pr.body),
                  }),
                );
                return;
              }
            },
            {
              matches: () => (tail === "/files" && method === "GET"),
              handle: function listPullFiles() {
                if (!requirePermissions("pull_requests:read")) return;
                json(res, 200, [
                  {
                    filename: "src/auth.ts",
                    additions: pr.additions ?? 0,
                    deletions: pr.deletions ?? 0,
                    patch: "@@ -1 +1,2 @@\n one\n+two",
                  },
                ]);
                return;
              }
            },
            {
              matches: () => (tail === "/reviews" && method === "GET"),
              handle: function listPullReviews() {
                if (!requirePermissions("pull_requests:read")) return;
                json(res, 200, []);
                return;
              }
            },
            {
              matches: () => (tail === "/reviews" && method === "POST"),
              handle: function submitPullReview() {
                if (!requirePermissions("pull_requests:write")) return;
                operations.push(`pr review ${number}`);
                json(res, 200, {});
                return;
              }
            },
            {
              matches: () => (tail === "/requested_reviewers" && method === "GET"),
              handle: function requestedReviewers() {
                if (!requirePermissions("pull_requests:read")) return;
                json(res, 200, { users: [], teams: [] });
                return;
              }
            },
            {
              matches: () => (tail === "/merge" && method === "PUT"),
              handle: async function mergePull() {
                if (!requirePermissions("contents:write")) return;
                const body = await requestBody(req);
                operations.push(
                  `pr merge ${number} --${String(body.merge_method ?? "merge")}`,
                );
                json(res, 200, { merged: true });
                return;
              }
            },
            {
              matches: () => (tail === "/update-branch" && method === "PUT"),
              handle: function updatePullBranch() {
                if (!requirePermissions("pull_requests:write", "contents:write"))
                  return;
                operations.push(`pr update-branch ${number}`);
                json(res, 202, { message: "Updating" });
                return;
              }
            },
            {
              matches: () => (replyMatch && method === "POST"),
              handle: function replyToReview() {
                if (!requirePermissions("pull_requests:write")) return;
                operations.push(`pr reply ${number}`);
                json(res, 201, {});
                return;
              }
            }
          ];
          const route = routes.find((candidate) => candidate.matches());
          if (route) return route.handle();
          json(res, 404, { message: "Not found" });
          return;
        }
      },
      {
        matches: () => (checksMatch && method === "GET"),
        handle: function readChecks() {
          if (!requirePermissions("checks:read")) return;
          const pr = prs.find(
            (candidate) => `e2ehead${candidate.number}` === checksMatch![1],
          );
          json(res, 200, {
            check_runs: (pr?.checks ?? []).map((check) => ({
              name: check.name,
              status: check.status ?? "completed",
              conclusion: check.conclusion ?? "success",
              details_url: check.detailsUrl ?? null,
              started_at: "2026-07-11T00:00:00Z",
              completed_at: "2026-07-11T00:00:48Z",
            })),
          });
          return;
        }
      },
      {
        matches: () => (/^\/commits\/[^/]+\/status$/.test(suffix) && method === "GET"),
        handle: function readCommitStatus() {
          if (!requirePermissions("statuses:read")) return;
          json(res, 200, { statuses: [] });
          return;
        }
      },
      {
        matches: () => (suffix === "/issues" && method === "GET"),
        handle: function listIssues() {
          if (!requirePermissions("issues:read")) return;
          json(res, 200, page(issues.map(issueJson), requestUrl));
          return;
        }
      },
      {
        matches: () => (issueMatch),
        handle: function routeIssue() {
          const number = Number(issueMatch![1]);
          const tail = issueMatch![2] ?? "";
          const issue = issues.find((candidate) => candidate.number === number);
          const pr = prs.find((candidate) => candidate.number === number);

          const routes = [
            {
              matches: () => (tail === "" && method === "GET" && issue),
              handle: function readIssue() {
                if (!requirePermissions("issues:read")) return;
                json(res, 200, issueJson(issue!));
                return;
              }
            },
            {
              matches: () => (tail === "/comments" && method === "GET"),
              handle: function readIssueComments() {
                if (!requirePermissions(pr ? "pull_requests:read" : "issues:read"))
                  return;
                json(res, 200, []);
                return;
              }
            },
            {
              matches: () => (tail === "/comments" && method === "POST"),
              handle: function createIssueComment() {
                if (!requirePermissions(pr ? "pull_requests:write" : "issues:write"))
                  return;
                operations.push(`${pr ? "pr" : "issue"} comment ${number}`);
                json(res, 201, {});
                return;
              }
            },
            {
              matches: () => (tail === "" && method === "PATCH"),
              handle: function updateIssue() {
                if (!requirePermissions("issues:write")) return;
                operations.push(`issue close ${number}`);
                json(res, 200, issue ? { ...issueJson(issue!), state: "closed" } : {});
                return;
              }
            }
          ];
          const route = routes.find((candidate) => candidate.matches());
          if (route) return route.handle();
          json(res, 404, { message: "Not found" });
          return;
        }
      }
    ];
    const route = routes.find((candidate) => candidate.matches());
    if (route) return route.handle();
    json(res, 404, { message: "Not found" });
    return;
  };
  const url = await new Promise<string>((resolve, reject) => {
    server = createServer(handleRequest);
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address() as AddressInfo;
      resolve(`http://127.0.0.1:${address.port}`);
    });
  });

  return {
    url,
    requests,
    operations,
    credentialRequests,
    connect: () => {
      connected = true;
      lastRefreshedAt = "2026-08-04T09:00:00.000Z";
    },
    setInstallation: (patch) => {
      installation = {
        ...installation,
        ...patch,
        account: patch.account ?? installation.account,
      };
    },
    addPr: (pr) => {
      prs.push(pr);
    },
    sessionRoute: (sessionId) => {
      const route = sessionRoutes.get(sessionId);
      return route
        ? {
            relaySessionId: route.relaySessionId,
            pullRequestNumber: route.pullRequestNumber,
            state: route.state,
          }
        : null;
    },
    failNext: (operation) => {
      failures.add(operation);
    },
    status,
    publishedPr: () => publishedPr,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
};

function pullHeadRepository(pr: FakeGitHubPr, login: string, cloneUrl: string | undefined) {
  return {
    id: pr.headRepository?.id ?? 301,
    full_name:
      pr.headRepository?.fullName ??
      `${login}/widget`,
    clone_url:
      pr.headRepository?.cloneUrl ??
      cloneUrl ??
      "https://github.com/acme/widget.git",
    ssh_url: pr.headRepository?.sshUrl ?? null,
  };
}

async function handleGraphql(req: IncomingMessage, res: ServerResponse, requirePermissions: (...permissions: readonly string[]) => boolean, operations: string[]) {
  const body = await requestBody(req);
  const query = String(body.query ?? "");
  const writesPullRequest =
    query.includes("markPullRequestReadyForReview") ||
    query.includes("resolveReviewThread") ||
    query.includes("unresolveReviewThread");
  if (
    !requirePermissions(
      writesPullRequest ? "pull_requests:write" : "pull_requests:read",
    )
  ) {
    return;
  }
  if (query.includes("markPullRequestReadyForReview"))
    operations.push("pr ready");
  if (query.includes("resolveReviewThread"))
    operations.push("review thread resolve");
  if (query.includes("unresolveReviewThread"))
    operations.push("review thread unresolve");
  if (query.includes("reviewThreads")) {
    json(res, 200, {
      data: {
        repository: {
          pullRequest: {
            reviewThreads: {
              pageInfo: { hasNextPage: false, endCursor: null },
              nodes: [],
            },
          },
        },
      },
    });
    return;
  }
  json(res, 200, { data: {} });
  return;
}

function authenticateInstallation(req: IncomingMessage, res: ServerResponse, installationTokens: Map<string, ReadonlySet<string>>, connected: boolean, installation: GitHubAppInstallation): ReadonlySet<string> | null {
  const authorization = req.headers.authorization ?? "";
  const installationToken = authorization.startsWith("Bearer ")
    ? authorization.slice("Bearer ".length)
    : "";
  const grantedPermissions = installationTokens.get(installationToken);
  if (!grantedPermissions) {
    json(res, 401, { message: "Bad credentials" });
    return null;
  }
  if (!connected) {
    json(res, 403, { message: "Installation disconnected" });
    return null;
  }
  if (installation.status === "suspended") {
    json(res, 403, { message: "Installation suspended" });
    return null;
  }

  return grantedPermissions;
}

function repositoryRequest(requestUrl: URL, installation: GitHubAppInstallation, res: ServerResponse) {
  const repositoryMatch = /^\/repos\/([^/]+)\/([^/]+)(.*)$/.exec(
    requestUrl.pathname,
  );
  if (!repositoryMatch) {
    json(res, 404, { message: "Not found" });
    return null;
  }
  const owner = decodeURIComponent(repositoryMatch[1]!);
  const repo = decodeURIComponent(repositoryMatch[2]!);
  const suffix = repositoryMatch[3] ?? "";
  if (owner.toLowerCase() !== installation.account.login.toLowerCase()) {
    json(res, 403, { message: "Resource not accessible by integration" });
    return null;
  }

  return { owner, repo, suffix };
}

function pullStateFields(pr: FakeGitHubPr) {
  const upperState = (pr.state ?? "OPEN").toUpperCase();
  const merged = upperState === "MERGED";
  return {
    state: merged || upperState === "CLOSED" ? "closed" : "open",
    merged_at: merged ? (pr.updatedAt ?? "2026-07-11T00:00:00Z") : null,
  };
}

function credentialScopes(scopes: unknown): string[] {
  return Array.isArray(scopes)
    ? scopes.filter(
      (scope): scope is string => typeof scope === "string",
    )
    : [];
}

type PublishedPull = {
  number: number;
  title: string;
  body: string;
  head: string;
  base: string;
};

function publishedPull(body: Record<string, unknown>): PublishedPull {
  return { number: 900, title: String(body.title ?? ""), body: String(body.body ?? ""), head: String(body.head ?? ""), base: String(body.base ?? "") };
}
function publishedHeadName(head: string): string {
  return head.includes(":") ? head.slice(head.indexOf(":") + 1) : head;
}

function updatePublishedPull(publishedPr: PublishedPull | null, number: number, body: Record<string, unknown>): PublishedPull | null {
  if (publishedPr?.number === number) {
    publishedPr = {
      ...publishedPr,
      title: String(body.title ?? publishedPr.title),
      body: String(body.body ?? publishedPr.body),
    };
  }
  return publishedPr;
}
