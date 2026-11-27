BEGIN;

CREATE TABLE IF NOT EXISTS companion_profiles (
  id text PRIMARY KEY,
  saved_at bigint NOT NULL,
  data jsonb NOT NULL
);

CREATE TABLE IF NOT EXISTS companion_settings (
  slot boolean PRIMARY KEY DEFAULT true CHECK (slot),
  last_seen bigint,
  active_profile text REFERENCES companion_profiles(id),
  recording boolean NOT NULL DEFAULT false
);
ALTER TABLE companion_settings ADD COLUMN IF NOT EXISTS control_readings jsonb;
INSERT INTO companion_settings (slot) VALUES (true) ON CONFLICT DO NOTHING;

CREATE TABLE IF NOT EXISTS companion_turns (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  session text NOT NULL,
  at bigint NOT NULL,
  user_text text NOT NULL,
  reply text NOT NULL
);

CREATE TABLE IF NOT EXISTS companion_command (
  slot boolean PRIMARY KEY DEFAULT true CHECK (slot),
  id text NOT NULL,
  payload jsonb NOT NULL,
  state text NOT NULL CHECK (state IN ('queued', 'sent', 'ok', 'error')),
  recipient text,
  result text,
  expires_at timestamptz NOT NULL
);

COMMIT;
