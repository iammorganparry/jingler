const managedAccount = (path: string): string =>
  new URL(path, "https://managed-account.internal").toString()
const offloadLifecycle = (path: string): string =>
  new URL(path, "https://offload-lifecycle.internal").toString()

/** Canonical Durable Object routes; callers never assemble internal URLs. */
export const INTERNAL_ROUTES = {
  managedAccount: {
    sessionRegister: managedAccount("/v1/sessions/register"),
    sessionUnregister: managedAccount("/v1/sessions/unregister"),
    sessionList: managedAccount("/v1/sessions/list"),
    authorize: managedAccount("/v1/authorize"),
    capabilities: managedAccount("/v1/capabilities"),
    authState: managedAccount("/v1/auth-state"),
    offloadRegister: managedAccount("/v1/offload/register"),
    offloadAuthorize: managedAccount("/v1/offload/authorize"),
    offloadUnregister: managedAccount("/v1/offload/unregister"),
    offloadConsumeGrant: managedAccount("/v1/offload/grants/consume")
  },
  offloadLifecycle: {
    touch: offloadLifecycle("/v1/touch"),
    destroy: offloadLifecycle("/v1/destroy")
  }
} as const
