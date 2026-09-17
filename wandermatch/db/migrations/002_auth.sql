-- Credentials live apart from `users` because Rule R1 forbids adding a
-- column to a provided table — and because auth secrets and profile data
-- should not share a blast radius anyway.
BEGIN;

CREATE TABLE IF NOT EXISTS auth_credentials (
  user_id        TEXT PRIMARY KEY,
  password_hash  TEXT NOT NULL,
  failed_attempts SMALLINT NOT NULL DEFAULT 0,
  locked_until   TIMESTAMPTZ,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE auth_credentials
  ADD CONSTRAINT fk_auth_user FOREIGN KEY (user_id) REFERENCES users(user_id) ON DELETE CASCADE;

COMMIT;
