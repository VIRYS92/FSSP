-- Authentication and protected document access indexes.
-- Existing tables already contain the data model; this migration tightens
-- the formats used by the Argon2id/session implementation.

ALTER TABLE users
  ADD CONSTRAINT users_password_hash_argon2id
  CHECK (password_hash LIKE '$argon2id$%');

ALTER TABLE user_sessions
  ADD CONSTRAINT user_sessions_token_hash_sha256
  CHECK (token_hash ~ '^[0-9a-f]{64}$');

CREATE INDEX users_active_role_idx ON users (is_active, role);
CREATE INDEX user_sessions_user_active_idx ON user_sessions (user_id, expires_at)
  WHERE revoked_at IS NULL;
CREATE INDEX documents_status_idx ON documents (status, created_at DESC);
