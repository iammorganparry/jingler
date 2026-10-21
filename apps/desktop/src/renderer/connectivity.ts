import { useSyncExternalStore } from "react"

/** Consecutive transport-level RPC failures that count as "offline" even if the OS says online. */
export const RPC_FAILURE_THRESHOLD = 3

export const isOffline = ({ navigatorOnline, consecutiveRpcFailures }: { navigatorOnline: boolean; consecutiveRpcFailures: number }): boolean =>
  !navigatorOnline || consecutiveRpcFailures >= RPC_FAILURE_THRESHOLD

/** Typed domain failures carry a `_tag`; a rejection without one never reached a handler. */
export const isTransportFailure = (failure: unknown): boolean =>
  !(typeof failure === "object" && failure !== null && "_tag" in failure)

export const isQuotaFailure = (failure: unknown): boolean =>
  typeof failure === "object" && failure !== null && "reason" in failure && failure.reason === "quota-exceeded"

type Snapshot = { readonly offline: boolean; readonly relayQuotaReached: boolean }

let navigatorOnline = typeof navigator === "undefined" ? true : navigator.onLine
let consecutiveRpcFailures = 0
let snapshot: Snapshot = { offline: false, relayQuotaReached: false }
const listeners = new Set<() => void>()

const publish = (patch: Partial<Snapshot> = {}) => {
  const next = { ...snapshot, offline: isOffline({ navigatorOnline, consecutiveRpcFailures }), ...patch }
  if (next.offline === snapshot.offline && next.relayQuotaReached === snapshot.relayQuotaReached) return
  snapshot = next
  for (const l of listeners) l()
}
publish()

if (typeof window !== "undefined") {
  window.addEventListener("online", () => { navigatorOnline = true; consecutiveRpcFailures = 0; publish() })
  window.addEventListener("offline", () => { navigatorOnline = false; publish() })
}

/** Called by the RPC client for every settled call. */
export const reportRpcResult = (failure?: unknown): void => {
  if (failure === undefined) consecutiveRpcFailures = 0
  else if (isTransportFailure(failure)) consecutiveRpcFailures += 1
  publish(isQuotaFailure(failure) ? { relayQuotaReached: true } : {})
}

export const useConnectivity = (): Snapshot =>
  useSyncExternalStore(
    (l) => { listeners.add(l); return () => listeners.delete(l) },
    () => snapshot
  )
