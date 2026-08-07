export interface RelayHealthState {
  readonly mode: string;
  readonly error: string | null;
}

export interface RelayHealthUpdate {
  readonly mode: string;
  readonly error?: string | null;
}

/**
 * Applies one relay status without letting a reconnect transition erase the
 * concrete transport/server error that caused it.
 */
export const applyRelayHealthUpdate = (
  statuses: Map<string, RelayHealthState>,
  key: string,
  update: RelayHealthUpdate,
): void => {
  if (update.mode === "stopped") {
    statuses.delete(key);
    return;
  }
  const previous = statuses.get(key);
  statuses.set(key, {
    mode: update.mode,
    error:
      update.error ??
      (update.mode === "reconnecting" ? (previous?.error ?? null) : null),
  });
};
