export interface ManagedAuthorizationState {
  readonly authStateVersion: number
  readonly sessionGeneration: number
  readonly processId: string | null
  readonly authorized: boolean
}

/** Applies a capability snapshot atomically; only actual revocation stops work. */
export const applyManagedAuthorizationSnapshot = async <
  State extends ManagedAuthorizationState
>(
  state: State,
  snapshotVersion: number | null,
  stopProcess: (processId: string) => Promise<void>
): Promise<State> => {
  if (snapshotVersion !== null) {
    return snapshotVersion === state.authStateVersion && state.authorized
      ? state
      : {
          ...state,
          authStateVersion: snapshotVersion,
          authorized: true
        }
  }
  if (!state.authorized) return state
  if (state.processId !== null) await stopProcess(state.processId)
  return {
    ...state,
    authStateVersion: state.authStateVersion,
    sessionGeneration: state.sessionGeneration + 1,
    processId: null,
    authorized: false
  }
}
