/**
 * The renderer's auth state machine — the sign-in wall's brain, kept SEPARATE
 * from `appMachine` so the (growing) auth surface doesn't bloat the app-level
 * flow. `App` gates the whole app on this reaching `signedIn`.
 *
 * States:
 *   checking      — validating any stored token (getSession) on boot / after a callback
 *   signedOut     — the wall; substates model the email + OAuth affordances:
 *     idle          — nothing in flight
 *     sending       — magic-link request in flight
 *     magicLinkSent — "check your email" confirmation
 *     oauthPending  — browser opened, awaiting the `jingler://` callback;
 *                     CANCEL/RESET return to idle, and it times out into `error`
 *     error         — a send/OAuth attempt failed; RETRY re-runs it, RESET clears it
 *   unreachable   — the auth check failed to reach the server (offline, 5xx): NOT signed out.
 *                   The app still shows, with a banner; RETRY (or a deep-link CALLBACK) re-runs `checking`
 *   signedIn      — authenticated; `SIGN_OUT` revokes and returns to the wall
 *   signingOut    — sign-out request in flight
 *
 * Room to grow: `signUp` / `forgotPassword` slot in as siblings of `signedOut`'s
 * substates without touching `appMachine`. The `CALLBACK` event (from the main
 * process's deep-link handler) re-runs `checking`, so both OAuth and magic-link
 * returns converge on the same validation path.
 */
import type { AuthProvider, AuthSession } from "@jingler/core"
import { assign, fromPromise, setup } from "xstate"
import { rpcFailureMessage } from "./rpc-failure.js"
import { rpc } from "./rpc-client.js"

/** How long the browser hand-off may stay unanswered before the wall offers a way out. */
export const OAUTH_TIMEOUT_MS = 120_000

/** The last send/OAuth attempt, so `error` can RETRY it. */
export type AuthAttempt = { readonly kind: "oauth"; readonly provider: AuthProvider } | { readonly kind: "magicLink" }

export interface AuthContext {
  /** Controlled email input (lifted so `sent`/`error` survive re-renders). */
  readonly email: string
  /** Display name from the sign-up form; sent with the magic link on sign-up. */
  readonly name: string | null
  /** The address a magic link was sent to (for the confirmation copy). */
  readonly sentEmail: string | null
  /** User-facing error message for the `error` substate. */
  readonly error: string | null
  /** The live session once signed in (so the app can read the user). */
  readonly session: AuthSession | null
  /** What `RETRY` re-runs from `error`. */
  readonly lastAttempt: AuthAttempt | null
  /** The provider URL opened for the in-flight OAuth hand-off, so the wall can copy it. */
  readonly signInUrl: string | null
}

export type AuthEvent =
  | { type: "OAUTH"; provider: AuthProvider }
  | { type: "MAGIC_LINK"; email: string; name?: string }
  | { type: "CALLBACK" }
  | { type: "RESET" }
  | { type: "CANCEL" }
  | { type: "RETRY" }
  | { type: "SIGN_OUT" }

const checkAuth = fromPromise<AuthSession | null>(() => rpc.authGetSession())

const sendMagicLink = fromPromise<void, { email: string; name: string | null }>(({ input }) =>
  rpc.authSendMagicLink(input.email, input.name ?? undefined)
)

const startOAuth = fromPromise<string, { provider: AuthProvider }>(async ({ input }) => {
  const url = await rpc.authStartSignIn(input.provider)
  await window.jingler.openExternal(url)
  return url
})

const signOut = fromPromise<void>(() => rpc.authSignOut())

export const authMachine = setup({
  types: {
    context: {} as AuthContext,
    events: {} as AuthEvent
  },
  actors: { checkAuth, sendMagicLink, startOAuth, signOut },
  guards: {
    hasSession: ({ event }) => "output" in event && event.output !== null,
    retriesOAuth: ({ context }) => context.lastAttempt?.kind === "oauth",
    retriesMagicLink: ({ context }) => context.lastAttempt?.kind === "magicLink"
  }
}).createMachine({
  id: "auth",
  initial: "checking",
  context: { email: "", name: null, sentEmail: null, error: null, session: null, lastAttempt: null, signInUrl: null },
  states: {
    checking: {
      invoke: {
        src: "checkAuth",
        onDone: [
          {
            guard: "hasSession",
            target: "signedIn",
            actions: assign({ session: ({ event }) => event.output })
          },
          { target: "signedOut" }
        ],
        onError: { target: "unreachable" }
      }
    },
    unreachable: {
      on: { RETRY: "checking", CALLBACK: "checking" }
    },
    signedOut: {
      initial: "idle",
      // OAuth / magic-link kick off from any substate; a deep-link callback
      // re-validates via `checking`.
      on: {
        OAUTH: {
          target: ".oauthPending",
          actions: assign({
            error: () => null,
            signInUrl: () => null,
            lastAttempt: ({ event }): AuthAttempt => ({ kind: "oauth", provider: event.provider })
          })
        },
        MAGIC_LINK: {
          target: ".sending",
          actions: assign({
            email: ({ event }) => event.email,
            name: ({ event }) => event.name ?? null,
            error: () => null,
            lastAttempt: (): AuthAttempt => ({ kind: "magicLink" })
          })
        },
        CALLBACK: "checking"
      },
      states: {
        idle: {},
        sending: {
          invoke: {
            src: "sendMagicLink",
            input: ({ context }) => ({ email: context.email, name: context.name }),
            onDone: {
              target: "magicLinkSent",
              actions: assign({ sentEmail: ({ context }) => context.email })
            },
            onError: {
              target: "error",
              actions: assign({
                error: () => "We couldn't send the sign-in link. Please try again."
              })
            }
          }
        },
        magicLinkSent: {
          on: {
            RESET: {
              target: "idle",
              actions: assign({ sentEmail: () => null, email: () => "", name: () => null })
            }
          }
        },
        oauthPending: {
          invoke: {
            src: "startOAuth",
            input: ({ context }) => ({
              provider: context.lastAttempt?.kind === "oauth" ? context.lastAttempt.provider : "github"
            }),
            onDone: { actions: assign({ signInUrl: ({ event }) => event.output }) },
            onError: {
              target: "error",
              actions: assign({
                error: ({ event }) =>
                  rpcFailureMessage(event.error, "Couldn't start sign-in. Please try again.")
              })
            }
          },
          // The browser may be closed without ever calling back; never strand the wall.
          // RETRY is the wall's "Still waiting? Try again": re-open the hand-off.
          on: {
            CANCEL: "idle",
            RESET: "idle",
            RETRY: { target: "oauthPending", reenter: true, actions: assign({ error: () => null, signInUrl: () => null }) }
          },
          after: {
            [OAUTH_TIMEOUT_MS]: {
              target: "error",
              actions: assign({ error: () => "Sign-in didn't finish in your browser. Try again." })
            }
          }
        },
        error: {
          on: {
            RESET: "idle",
            RETRY: [
              { guard: "retriesOAuth", target: "oauthPending", actions: assign({ error: () => null }) },
              { guard: "retriesMagicLink", target: "sending", actions: assign({ error: () => null }) }
            ]
          }
        }
      }
    },
    signedIn: {
      on: { SIGN_OUT: "signingOut" }
    },
    signingOut: {
      invoke: {
        src: "signOut",
        onDone: { target: "signedOut", actions: assign({ session: () => null }) },
        onError: { target: "signedOut", actions: assign({ session: () => null }) }
      }
    }
  }
})
