import { afterAll, describe, expect, it, vi } from "vitest"
import { POST as grantMemory } from "../app/api/memory/grant/route.js"
import { GET as listMemoryOrganizations } from "../app/api/memory/organizations/route.js"
import { app } from "./app.js"
import { sql } from "./db/client.js"
import { runtime } from "./runtime.js"

/**
 * End-to-end HTTP coverage of the auth backend against a REAL Postgres — exercises
 * BetterAuth + Drizzle + the repository layer through Hono's `app.request`, no
 * network server. Needs Docker Postgres, so it's gated behind JINGLER_DB_TESTS
 * and excluded from the CI unit run (see `vitest.config.ts`); run it with
 * `pnpm --filter @jingler/server test:integration` after `docker compose up -d db`
 * and `db:migrate`.
 */
const RUN = process.env.JINGLER_DB_TESTS === "1"

const cookieFrom = (res: Response): string => (res.headers.get("set-cookie") ?? "").split(";")[0] ?? ""

describe.skipIf(!RUN)("auth backend (integration, needs Postgres)", () => {
  afterAll(async () => {
    await runtime.dispose()
    await sql.end()
  })

  it("health check responds", async () => {
    const res = await app.request("/health")
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ status: "ok" })
  })

  it("magic link → session → bearer → /api/me → sign out", async () => {
    const email = `it_${Date.now()}@example.com`

    // 1. Request a magic link; capture the verify URL logged to the console.
    const logs: Array<string> = []
    const spy = vi.spyOn(console, "log").mockImplementation((...args) => {
      logs.push(args.join(" "))
    })
    const sent = await app.request("/api/auth/sign-in/magic-link", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, callbackURL: "http://localhost:9100/desktop/callback" })
    })
    spy.mockRestore()
    expect(sent.status).toBe(200)

    const verifyUrl = logs.join("\n").match(/https?:\/\/\S*magic-link\/verify\S*/)?.[0]
    expect(verifyUrl, "magic-link verify URL should be logged in dev").toBeTruthy()
    const verifyPath = verifyUrl!.replace(/^https?:\/\/[^/]+/, "")

    // 2. "Click" the link: BetterAuth verifies, creates the session, sets a cookie.
    const verified = await app.request(verifyPath)
    const cookie = cookieFrom(verified)
    expect(cookie).toContain("=")

    // 3. Desktop bridge: reads the session cookie → jingler:// deep link w/ token.
    const bridge = await app.request("/desktop/callback", { headers: { cookie } })
    expect(bridge.status).toBe(302)
    const location = bridge.headers.get("location") ?? ""
    const token = new URL(location).searchParams.get("token")
    expect(token, "bridge should redirect with a token").toBeTruthy()

    // 4. /api/me (repository-backed) with the bearer token returns the user.
    const me = await app.request("/api/me", { headers: { Authorization: `Bearer ${token}` } })
    expect(me.status).toBe(200)
    const meBody = (await me.json()) as { user: { email: string } }
    expect(meBody.user.email).toBe(email)

    // 5. The same BetterAuth bearer can mint a short-lived grant only for its
    // exact active paid organization membership.
    const organizationId = `org_${Date.now()}`
    await sql`
      insert into organization (id, name, slug, metadata, created_at)
      values (
        ${organizationId},
        'Integration Team',
        ${`integration-${Date.now()}`},
        ${JSON.stringify({ plan: "team", status: "active" })},
        now()
      )
    `
    await sql`
      insert into member (id, organization_id, user_id, role, created_at)
      select ${`member_${Date.now()}`}, ${organizationId}, id, 'owner', now()
      from "user"
      where email = ${email}
    `
    const grantResponse = await grantMemory(
      new Request("http://localhost:9100/api/memory/grant", {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ organizationId })
      })
    )
    expect(grantResponse.status).toBe(200)
    expect(await grantResponse.json()).toMatchObject({
      claims: {
        organizationId,
        privileges: ["read", "propose", "review", "schema"]
      }
    })
    const organizationsResponse = await listMemoryOrganizations(
      new Request("http://localhost:9100/api/memory/organizations", {
        headers: { authorization: `Bearer ${token}` }
      })
    )
    expect(organizationsResponse.status).toBe(200)
    expect(await organizationsResponse.json()).toMatchObject({
      organizations: [{
        id: organizationId,
        name: "Integration Team",
        role: "owner",
        privileges: ["read", "propose", "review", "schema"]
      }]
    })

    // 6. Sign out revokes the session.
    const out = await app.request("/api/auth/sign-out", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` }
    })
    expect(out.status).toBe(200)
  })

  it("/api/me is 401 without a bearer token", async () => {
    const res = await app.request("/api/me")
    expect(res.status).toBe(401)
  })
})
