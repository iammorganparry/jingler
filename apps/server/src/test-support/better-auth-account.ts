import { betterAuth } from "better-auth"
import { memoryAdapter } from "better-auth/adapters/memory"
import { bearer, testUtils } from "better-auth/plugins"
import { serve } from "@hono/node-server"
import type { AddressInfo } from "node:net"

const TEST_AUTH_URL = "http://127.0.0.1:9100"
const TEST_AUTH_SECRET = "jingler-test-auth-secret-is-not-for-production"

export interface BetterAuthTestAccount {
  readonly auth: ReturnType<typeof createTestAuth>
  readonly email: string
  readonly headers: Headers
  readonly token: string
  readonly userId: string
}

export interface BetterAuthTestServer extends BetterAuthTestAccount {
  readonly close: () => Promise<void>
  readonly url: string
}

const createTestAuth = () =>
  betterAuth({
    baseURL: TEST_AUTH_URL,
    database: memoryAdapter({}),
    secret: TEST_AUTH_SECRET,
    plugins: [bearer(), testUtils()]
  })

/**
 * Create a real Better Auth account and bearer session without an email round
 * trip. This module lives under test-support so privileged helpers never enter
 * the production auth instance or register a production HTTP route.
 */
export const createBetterAuthTestAccount = async (
  email = "desktop-e2e@jingler.test"
): Promise<BetterAuthTestAccount> => {
  const auth = createTestAuth()
  const context = await auth.$context
  const user = context.test.createUser({
    email,
    emailVerified: true,
    name: "Jingler E2E"
  })
  await context.test.saveUser(user)
  const login = await context.test.login({ userId: user.id })
  return {
    auth,
    email: user.email,
    headers: new Headers({ authorization: `Bearer ${login.token}` }),
    token: login.token,
    userId: user.id
  }
}

/**
 * Serve the genuine Better Auth handler with a privileged test-only account.
 * Electron tests can therefore exercise bearer validation without email, a
 * fake auth protocol, or any route added to Jingler's production server.
 */
export const startBetterAuthTestServer = async (
  email?: string
): Promise<BetterAuthTestServer> => {
  const account = await createBetterAuthTestAccount(email)
  const server = await new Promise<ReturnType<typeof serve>>((resolve) => {
    const listening = serve(
      {
        fetch: (request) => account.auth.handler(request),
        hostname: "127.0.0.1",
        port: 0
      },
      () => resolve(listening)
    )
  })
  const address = server.address() as AddressInfo

  return {
    ...account,
    url: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()))
      })
  }
}
