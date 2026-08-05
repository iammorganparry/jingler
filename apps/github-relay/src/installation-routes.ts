import { DurableObject } from "cloudflare:workers"
import { RELAY_POLICY, relayTelemetry } from "./env.js"
import type { NormalizedGitHubEvent } from "./github-webhook.js"

export type InstallationState = "active" | "suspended" | "removed"
export type SessionRouteState = "active" | "archived" | "removed"

export interface SessionRouteMutation {
  readonly mutationId: string
  readonly generation: number
  readonly state: SessionRouteState
  readonly userId: string
  readonly installationId: string
  readonly repositoryId: string
  readonly pullRequestNumber: number
  readonly relaySessionId: string
}

export interface SessionRoute {
  readonly userId: string
  readonly installationId: string
  readonly repositoryId: string
  readonly pullRequestNumber: number
  readonly relaySessionId: string
}

interface CountRow {
  readonly [key: string]: SqlStorageValue
  readonly count: number
}

interface RouteRow {
  readonly [key: string]: SqlStorageValue
  readonly user_id: string
  readonly installation_id: string
  readonly repository_id: string
  readonly pull_request_number: number
  readonly relay_session_id: string
  readonly status: string
  readonly generation: number
}

interface OwnerRow {
  readonly [key: string]: SqlStorageValue
  readonly user_id: string
  readonly status: string
  readonly generation: number
}

interface InstallationStateRow {
  readonly [key: string]: SqlStorageValue
  readonly status: string
  readonly generation: number
}

interface GenerationRow {
  readonly [key: string]: SqlStorageValue
  readonly generation: number
}

interface DeliveryRow {
  readonly [key: string]: SqlStorageValue
  readonly delivery_id: string
}

interface WorkflowStartRow {
  readonly [key: string]: SqlStorageValue
  readonly status: string
  readonly workflow_id: string
  readonly attempt: number
}

/** One strongly-consistent route index per GitHub installation. */
export class InstallationRoutesObject extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    ctx.blockConcurrencyWhile(async () => {
      this.ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS owners (
          user_id TEXT PRIMARY KEY,
          status TEXT NOT NULL,
          generation INTEGER NOT NULL DEFAULT 0,
          updated_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS installation_state (
          singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
          status TEXT NOT NULL,
          generation INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );
        INSERT OR IGNORE INTO installation_state (singleton, status, generation, updated_at)
          VALUES (1, 'active', 0, 0);
        CREATE TABLE IF NOT EXISTS session_routes (
          installation_id TEXT NOT NULL,
          repository_id TEXT NOT NULL,
          pull_request_number INTEGER NOT NULL,
          user_id TEXT NOT NULL,
          relay_session_id TEXT NOT NULL UNIQUE,
          status TEXT NOT NULL,
          generation INTEGER NOT NULL DEFAULT 0,
          updated_at INTEGER NOT NULL,
          PRIMARY KEY (repository_id, pull_request_number)
        );
        CREATE INDEX IF NOT EXISTS session_routes_user_status
          ON session_routes(user_id, status);
        CREATE TABLE IF NOT EXISTS session_generations (
          relay_session_id TEXT PRIMARY KEY,
          generation INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS mutations (
          mutation_id TEXT PRIMARY KEY,
          created_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS deliveries (
          delivery_id TEXT PRIMARY KEY,
          relay_session_id TEXT,
          created_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS deliveries_created_at ON deliveries(created_at);
        CREATE TABLE IF NOT EXISTS workflow_starts (
          delivery_id TEXT PRIMARY KEY,
          workflow_id TEXT NOT NULL,
          status TEXT NOT NULL,
          attempt INTEGER NOT NULL DEFAULT 0,
          created_at INTEGER NOT NULL
        );
      `)
      // v1 objects stored only the delivery id and timestamp. Keep the namespace
      // migration in place and extend those existing SQLite databases in situ.
      try {
        this.ctx.storage.sql.exec("ALTER TABLE deliveries ADD COLUMN relay_session_id TEXT")
      } catch (error) {
        if (!(error instanceof Error) || !error.message.includes("duplicate column name")) throw error
      }
      for (const statement of [
        "ALTER TABLE owners ADD COLUMN generation INTEGER NOT NULL DEFAULT 0",
        "ALTER TABLE session_routes ADD COLUMN generation INTEGER NOT NULL DEFAULT 0"
      ]) {
        try {
          this.ctx.storage.sql.exec(statement)
        } catch (error) {
          if (!(error instanceof Error) || !error.message.includes("duplicate column name")) throw error
        }
      }
    })
  }

  async setOwner(
    userId: string,
    state: InstallationState,
    installationId: string,
    generation: number,
    mutationId = `owner:${userId}:${state}`
  ): Promise<{ readonly applied: boolean; readonly closedSockets: number }> {
    if (this.mutationApplied(mutationId)) return { applied: false, closedSockets: 0 }
    const current = this.ctx.storage.sql
      .exec<OwnerRow>("SELECT user_id, status, generation FROM owners WHERE user_id = ?", userId)
      .toArray()[0]
    if (current && current.generation >= generation) {
      this.recordMutation(mutationId)
      return { applied: false, closedSockets: 0 }
    }
    const routes = this.routesForUser(userId)
    this.ctx.storage.sql.exec(
      `INSERT INTO owners (user_id, status, generation, updated_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(user_id) DO UPDATE SET
         status = excluded.status,
         generation = excluded.generation,
         updated_at = excluded.updated_at`,
      userId,
      state,
      generation,
      Date.now()
    )
    if (state === "removed") {
      this.ctx.storage.sql.exec(
        "UPDATE session_routes SET status = 'removed', updated_at = ? WHERE user_id = ?",
        Date.now(),
        userId
      )
    }
    const closedSockets =
      state === "active" ? 0 : await this.closeSessionSockets(routes, "Installation unavailable")
    this.recordMutation(mutationId)
    relayTelemetry("installation_registration", { installationId, state, closedSockets })
    return { applied: true, closedSockets }
  }

  async setAllState(
    installationId: string,
    state: InstallationState,
    generation: number,
    mutationId: string
  ): Promise<{ readonly applied: boolean; readonly affectedRoutes: number }> {
    if (this.mutationApplied(mutationId)) return { applied: false, affectedRoutes: 0 }
    const current = this.ctx.storage.sql
      .exec<InstallationStateRow>(
        "SELECT status, generation FROM installation_state WHERE singleton = 1"
      )
      .one()
    if (current.generation >= generation) {
      this.recordMutation(mutationId)
      return { applied: false, affectedRoutes: 0 }
    }
    const routes = this.allRoutes()
    this.ctx.storage.sql.exec(
      "UPDATE installation_state SET status = ?, generation = ?, updated_at = ? WHERE singleton = 1",
      state,
      generation,
      Date.now()
    )
    if (state === "removed") {
      this.ctx.storage.sql.exec("UPDATE session_routes SET status = 'removed', updated_at = ?", Date.now())
    }
    if (state !== "active") await this.closeSessionSockets(routes, "Installation unavailable")
    this.recordMutation(mutationId)
    relayTelemetry("installation_lifecycle", {
      installationId,
      state,
      affectedRoutes: routes.length
    })
    return { applied: true, affectedRoutes: routes.length }
  }

  async applySessionRoute(
    mutation: SessionRouteMutation
  ): Promise<{ readonly applied: boolean; readonly closedSockets: number }> {
    if (this.mutationApplied(mutation.mutationId)) return { applied: false, closedSockets: 0 }

    const existing = this.ctx.storage.sql
      .exec<RouteRow>(
        `SELECT user_id, installation_id, repository_id, pull_request_number, relay_session_id, status, generation
         FROM session_routes WHERE repository_id = ? AND pull_request_number = ?`,
        mutation.repositoryId,
        mutation.pullRequestNumber
      )
      .toArray()[0]
    const sessionGeneration = this.ctx.storage.sql
      .exec<GenerationRow>(
        "SELECT generation FROM session_generations WHERE relay_session_id = ?",
        mutation.relaySessionId
      )
      .toArray()[0]?.generation
    if (
      (existing && existing.generation >= mutation.generation) ||
      (sessionGeneration !== undefined && sessionGeneration >= mutation.generation)
    ) {
      this.recordMutation(mutation.mutationId)
      return { applied: false, closedSockets: 0 }
    }
    let closedSockets = 0
    if (existing && existing.relay_session_id !== mutation.relaySessionId) {
      closedSockets += await this.env.SESSION_EVENTS.getByName(existing.relay_session_id).closeSockets(
        "Session route replaced"
      )
    }

    // A session can move to another repository/PR tuple while retaining its
    // opaque relay id. Remove the old tuple index only after recording a newer
    // session generation so delayed Workflows cannot recreate it.
    this.ctx.storage.sql.exec(
      `INSERT INTO session_generations (relay_session_id, generation, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(relay_session_id) DO UPDATE SET
         generation = excluded.generation,
         updated_at = excluded.updated_at`,
      mutation.relaySessionId,
      mutation.generation,
      Date.now()
    )
    this.ctx.storage.sql.exec(
      `DELETE FROM session_routes
       WHERE relay_session_id = ? AND (repository_id != ? OR pull_request_number != ?)`,
      mutation.relaySessionId,
      mutation.repositoryId,
      mutation.pullRequestNumber
    )

    this.ctx.storage.sql.exec(
      `INSERT INTO session_routes
          (installation_id, repository_id, pull_request_number, user_id, relay_session_id, status, generation, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(repository_id, pull_request_number) DO UPDATE SET
           installation_id = excluded.installation_id,
           user_id = excluded.user_id,
           relay_session_id = excluded.relay_session_id,
           status = excluded.status,
           generation = excluded.generation,
           updated_at = excluded.updated_at`,
      mutation.installationId,
      mutation.repositoryId,
      mutation.pullRequestNumber,
      mutation.userId,
      mutation.relaySessionId,
      mutation.state,
      mutation.generation,
      Date.now()
    )
    if (mutation.state !== "active") {
      closedSockets += await this.env.SESSION_EVENTS.getByName(mutation.relaySessionId).closeSockets(
        "Session route inactive"
      )
    }
    this.recordMutation(mutation.mutationId)
    this.prune()
    relayTelemetry("session_route_registration", {
      installationId: mutation.installationId,
      repositoryId: mutation.repositoryId,
      pullRequestNumber: mutation.pullRequestNumber,
      state: mutation.state,
      closedSockets
    })
    return { applied: true, closedSockets }
  }

  async resolveRoute(repositoryId: string, pullRequestNumber: number): Promise<SessionRoute | null> {
    return this.currentRoute(repositoryId, pullRequestNumber)
  }

  async routeEvent(
    event: NormalizedGitHubEvent
  ): Promise<{
    readonly routedSessions: number
    readonly insertedSessions: number
    readonly relaySessionIds: readonly string[]
  } | null> {
    const pullRequests = event.routePullRequests ?? (event.pullRequest ? [event.pullRequest] : [])
    if (pullRequests.length === 0) return null
    return this.ctx.blockConcurrencyWhile(async () => {
      const routes = pullRequests.flatMap((pullRequest) => {
        const route = this.currentRoute(event.repository.id, pullRequest.number)
        return route ? [{ route, pullRequest }] : []
      })
      if (routes.length === 0) return null
      const publications = await Promise.all(
        routes.map(({ route, pullRequest }) => {
          const routedEvent: NormalizedGitHubEvent = {
            ...event,
            pullRequest,
            routePullRequests: undefined
          }
          return this.env.SESSION_EVENTS.getByName(route.relaySessionId).publish(routedEvent)
        })
      )
      await this.completeDelivery(event.deliveryId, routes[0]!.route.relaySessionId)
      return {
        routedSessions: routes.length,
        insertedSessions: publications.filter(({ inserted }) => inserted).length,
        relaySessionIds: routes.map(({ route }) => route.relaySessionId)
      }
    })
  }

  private currentRoute(repositoryId: string, pullRequestNumber: number): SessionRoute | null {
    const row = this.ctx.storage.sql
      .exec<RouteRow>(
        `SELECT r.user_id, r.installation_id, r.repository_id, r.pull_request_number, r.relay_session_id, r.status
         FROM session_routes r
         JOIN owners o ON o.user_id = r.user_id
         JOIN installation_state i ON i.singleton = 1
         WHERE r.repository_id = ? AND r.pull_request_number = ?
           AND r.status = 'active' AND o.status = 'active' AND i.status = 'active'`,
        repositoryId,
        pullRequestNumber
      )
      .toArray()[0]
    return row
      ? {
          userId: row.user_id,
          installationId: row.installation_id,
          repositoryId: row.repository_id,
          pullRequestNumber: row.pull_request_number,
          relaySessionId: row.relay_session_id
        }
      : null
  }

  async ownsSession(userId: string, relaySessionId: string): Promise<boolean> {
    return (
      this.ctx.storage.sql
        .exec<CountRow>(
          `SELECT COUNT(*) AS count FROM session_routes r
           JOIN owners o ON o.user_id = r.user_id
           JOIN installation_state i ON i.singleton = 1
           WHERE r.user_id = ? AND r.relay_session_id = ?
             AND r.status = 'active' AND o.status = 'active' AND i.status = 'active'`,
          userId,
          relaySessionId
        )
        .one().count === 1
    )
  }

  async deliveryCompleted(deliveryId: string): Promise<boolean> {
    return (
      this.ctx.storage.sql
        .exec<DeliveryRow>("SELECT delivery_id FROM deliveries WHERE delivery_id = ?", deliveryId)
        .toArray().length > 0
    )
  }

  async prepareDeliveryWorkflow(
    deliveryId: string,
    baseWorkflowId: string
  ): Promise<{
    readonly duplicate: boolean
    readonly shouldCreate: boolean
    readonly workflowId: string
  }> {
    this.prune()
    const existing = this.ctx.storage.sql
      .exec<WorkflowStartRow>(
        "SELECT status, workflow_id, attempt FROM workflow_starts WHERE delivery_id = ?",
        deliveryId
      )
      .toArray()[0]
    if (existing) {
      if (existing.status === "started") {
        return { duplicate: true, shouldCreate: false, workflowId: existing.workflow_id }
      }
      if (existing.status === "pending") {
        return { duplicate: true, shouldCreate: true, workflowId: existing.workflow_id }
      }
      const attempt = existing.attempt + 1
      const workflowId = `${baseWorkflowId}-retry-${attempt}`
      this.ctx.storage.sql.exec(
        `UPDATE workflow_starts SET workflow_id = ?, status = 'pending', attempt = ?, created_at = ?
         WHERE delivery_id = ?`,
        workflowId,
        attempt,
        Date.now(),
        deliveryId
      )
      return { duplicate: true, shouldCreate: true, workflowId }
    }
    this.ctx.storage.sql.exec(
      `INSERT INTO workflow_starts (delivery_id, workflow_id, status, attempt, created_at)
       VALUES (?, ?, 'pending', 0, ?)`,
      deliveryId,
      baseWorkflowId,
      Date.now()
    )
    return { duplicate: false, shouldCreate: true, workflowId: baseWorkflowId }
  }

  async confirmDeliveryWorkflow(deliveryId: string): Promise<void> {
    this.ctx.storage.sql.exec(
      "UPDATE workflow_starts SET status = 'started' WHERE delivery_id = ?",
      deliveryId
    )
  }

  async releaseDeliveryWorkflow(deliveryId: string): Promise<void> {
    this.ctx.storage.sql.exec(
      "UPDATE workflow_starts SET status = 'retry' WHERE delivery_id = ?",
      deliveryId
    )
  }

  async completeDelivery(deliveryId: string, relaySessionId: string): Promise<void> {
    this.ctx.storage.sql.exec(
      "INSERT OR IGNORE INTO deliveries (delivery_id, relay_session_id, created_at) VALUES (?, ?, ?)",
      deliveryId,
      relaySessionId,
      Date.now()
    )
    this.prune()
  }

  private mutationApplied(mutationId: string): boolean {
    return (
      this.ctx.storage.sql
        .exec<CountRow>("SELECT COUNT(*) AS count FROM mutations WHERE mutation_id = ?", mutationId)
        .one().count > 0
    )
  }

  private recordMutation(mutationId: string): void {
    this.ctx.storage.sql.exec(
      "INSERT OR IGNORE INTO mutations (mutation_id, created_at) VALUES (?, ?)",
      mutationId,
      Date.now()
    )
  }

  private routesForUser(userId: string): readonly RouteRow[] {
    return this.ctx.storage.sql
      .exec<RouteRow>(
        `SELECT user_id, installation_id, repository_id, pull_request_number, relay_session_id, status, generation
         FROM session_routes WHERE user_id = ?`,
        userId
      )
      .toArray()
  }

  private allRoutes(): readonly RouteRow[] {
    return this.ctx.storage.sql
      .exec<RouteRow>(
        `SELECT user_id, installation_id, repository_id, pull_request_number, relay_session_id, status, generation
         FROM session_routes`
      )
      .toArray()
  }

  private async closeSessionSockets(routes: readonly RouteRow[], reason: string): Promise<number> {
    const uniqueSessionIds = [...new Set(routes.map((route) => route.relay_session_id))]
    const closed = await Promise.all(
      uniqueSessionIds.map((sessionId) =>
        this.env.SESSION_EVENTS.getByName(sessionId).closeSockets(reason)
      )
    )
    return closed.reduce((total, count) => total + count, 0)
  }

  private prune(): void {
    const cutoff = Date.now() - RELAY_POLICY.eventRetentionMs
    this.ctx.storage.sql.exec("DELETE FROM deliveries WHERE created_at < ?", cutoff)
    this.ctx.storage.sql.exec("DELETE FROM mutations WHERE created_at < ?", cutoff)
    this.ctx.storage.sql.exec("DELETE FROM workflow_starts WHERE created_at < ?", cutoff)
    this.ctx.storage.sql.exec(
      `DELETE FROM session_generations
       WHERE updated_at < ? AND relay_session_id NOT IN (SELECT relay_session_id FROM session_routes)`,
      cutoff
    )
    const count = this.ctx.storage.sql
      .exec<CountRow>("SELECT COUNT(*) AS count FROM session_routes")
      .one().count
    if (count > RELAY_POLICY.maxRoutesPerInstallation) {
      this.ctx.storage.sql.exec(
        `DELETE FROM session_routes WHERE relay_session_id IN (
          SELECT relay_session_id FROM session_routes
          WHERE status != 'active' AND updated_at < ? ORDER BY updated_at ASC LIMIT ?
        )`,
        cutoff,
        count - RELAY_POLICY.maxRoutesPerInstallation
      )
    }
  }
}
