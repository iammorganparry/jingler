export interface ManagedAuthorizationState {
  readonly authStateVersion: number
  readonly sessionGeneration: number
  readonly processId: string | null
  readonly authorized: boolean
}

/** Applies a capability snapshot atomically and fences every earlier session grant. */
export const applyManagedAuthorizationSnapshot = async <
  State extends ManagedAuthorizationState
>(
  state: State,
  snapshotVersion: number | null,
  stopProcess: (processId: string) => Promise<void>
): Promise<State> => {
  if (
    snapshotVersion === state.authStateVersion &&
    snapshotVersion !== null &&
    state.authorized
  ) {
    return state
  }
  if (state.processId !== null) await stopProcess(state.processId)
  return {
    ...state,
    authStateVersion: snapshotVersion ?? state.authStateVersion,
    sessionGeneration: state.sessionGeneration + 1,
    processId: null,
    authorized: snapshotVersion !== null
  }
}

