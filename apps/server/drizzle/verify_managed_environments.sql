-- Safe, read-only rollout gate. Run after migrations and before setting
-- MANAGED_ENVIRONMENTS_ENABLED=true in production.
DO $$
DECLARE
  missing text[];
BEGIN
  SELECT array_agg(required.name ORDER BY required.name)
  INTO missing
  FROM (
    VALUES
      ('managed_environment'),
      ('managed_session_runtime'),
      ('managed_usage_reservation'),
      ('workspace_checkpoint'),
      ('managed_environment_user_idempotency_unique'),
      ('managed_environment_user_state_updated_idx'),
      ('managed_runtime_user_session_unique'),
      ('managed_usage_user_window_state_idx'),
      ('workspace_checkpoint_runtime_digest_unique')
  ) AS required(name)
  WHERE to_regclass('public.' || required.name) IS NULL;

  IF missing IS NOT NULL THEN
    RAISE EXCEPTION 'managed environment migration is incomplete: %', missing;
  END IF;
END $$;
