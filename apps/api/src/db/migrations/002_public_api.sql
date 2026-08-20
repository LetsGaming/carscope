-- Keys are issued by whoever can reach the deployment, never through the API.
--
-- Only a SHA-256 of the secret is stored. The token is 24 bytes of CSPRNG
-- output, so there is nothing to brute force and no reason to pay for a KDF --
-- which would also mean a native module this build has no way to compile.
-- Lookup is an exact match on the unique hash, so no comparison happens in
-- application code and there is nothing to time.
CREATE TABLE api_keys (
  id            TEXT PRIMARY KEY,
  -- The leading, non-secret part of the token. Names a key in a log line and in
  -- the CLI so the secret is never written down a second time.
  prefix        TEXT NOT NULL UNIQUE,
  token_hash    TEXT NOT NULL UNIQUE,
  label         TEXT NOT NULL,
  -- Comma-separated; `admin` implies `write`. A key with neither is read-only
  -- and exists only to lift its holder out of the anonymous rate tier, which is
  -- why there is no `read` scope to grant.
  scopes        TEXT NOT NULL DEFAULT '',
  created_at    TEXT NOT NULL,
  expires_at    TEXT,
  revoked_at    TEXT,
  -- Written at most once an hour per key, and never on a failed check. SQLite
  -- has one writer and a collection run holds it; a write per request queues
  -- reads behind it for up to the busy_timeout, and a write on a failed check
  -- is free write amplification for anyone who can reach the port.
  last_used_at  TEXT
) WITHOUT ROWID;

-- One row per (search, endpoint). The secret is stored as given because it has
-- to be replayed to sign every delivery: it is a shared HMAC key, not a
-- password, and a hash of it could not sign anything.
CREATE TABLE webhooks (
  id                    TEXT PRIMARY KEY,
  search_id             TEXT NOT NULL REFERENCES searches (id) ON DELETE CASCADE,
  url                   TEXT NOT NULL,
  secret                TEXT NOT NULL,
  enabled               INTEGER NOT NULL DEFAULT 1,
  created_at            TEXT NOT NULL,
  -- A rowid cursor, not a timestamp. resolveVehicle stamps first_seen_at inside
  -- the same synchronous block as the INSERT, so a tight loop writes many rows
  -- in one millisecond: a `>` cursor skips those ties and a `>=` cursor
  -- redelivers them. rowid is assigned at insert and cannot tie.
  -- Advanced only after a delivery succeeds.
  notified_through      INTEGER NOT NULL DEFAULT 0,
  last_delivery_at      TEXT,
  last_status           INTEGER,
  -- A dead endpoint would otherwise pin the cursor forever and grow every
  -- payload; past the limit the hook is disabled and the cursor released.
  consecutive_failures  INTEGER NOT NULL DEFAULT 0,
  UNIQUE (search_id, url)
) WITHOUT ROWID;
CREATE INDEX idx_webhooks_search ON webhooks (search_id, enabled);

-- Serves the public `?since=` filter. The change cursor itself rides on rowid
-- and needs no index of its own.
CREATE INDEX idx_vehicles_first_seen ON vehicles (first_seen_at);
