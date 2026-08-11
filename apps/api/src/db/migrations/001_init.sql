CREATE TABLE searches (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  criteria    TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

CREATE TABLE vehicles (
  id                 TEXT PRIMARY KEY,
  make               TEXT NOT NULL,
  model              TEXT NOT NULL,
  variant            TEXT,
  body_style         TEXT,
  first_registration TEXT,
  mileage_km         INTEGER,
  -- Watts, not kilowatts: 206 PS stored as 152 kW reads back as 207 PS, and a
  -- car advertised as a 206 PS GT-T should never render as anything else.
  power_w            INTEGER,
  fuel               TEXT,
  gearbox            TEXT,
  seller_type        TEXT,
  seller_name        TEXT,
  market             TEXT NOT NULL,
  postal_code        TEXT,
  city               TEXT,
  damaged            INTEGER,
  identity_key       TEXT NOT NULL,
  image_hash         TEXT,
  description        TEXT,
  detail_fetched_at  TEXT,
  -- What the portal says about when the advert went online, where it says so.
  -- Null means the only figure available is how long we have been watching.
  first_listed_at    TEXT,
  first_seen_at      TEXT NOT NULL,
  last_seen_at       TEXT NOT NULL,
  delisted_at        TEXT
);
CREATE INDEX idx_vehicles_identity ON vehicles (identity_key);
CREATE INDEX idx_vehicles_image_hash ON vehicles (image_hash);
CREATE INDEX idx_vehicles_active ON vehicles (delisted_at, market);
-- Two portals that name the model differently only ever meet on make plus mileage.
CREATE INDEX idx_vehicles_mileage ON vehicles (mileage_km, make);

CREATE TABLE listings (
  id                TEXT PRIMARY KEY,
  vehicle_id        TEXT NOT NULL REFERENCES vehicles (id) ON DELETE CASCADE,
  source_id         TEXT NOT NULL,
  source_listing_id TEXT NOT NULL,
  url               TEXT NOT NULL,
  title             TEXT NOT NULL,
  -- The portal the advert is on, where that differs from the source we read.
  -- AutoUncle is an aggregator: its results are adverts on mobile.de, AutoScout24
  -- and others, and "found via AutoUncle" is not the answer to "where is this car".
  origin            TEXT,
  first_seen_at     TEXT NOT NULL,
  last_seen_at      TEXT NOT NULL,
  delisted_at       TEXT,
  UNIQUE (source_id, source_listing_id)
);
CREATE INDEX idx_listings_vehicle ON listings (vehicle_id);

-- Append-only. Nothing in the application updates or deletes a snapshot.
CREATE TABLE price_snapshots (
  vehicle_id  TEXT NOT NULL REFERENCES vehicles (id) ON DELETE CASCADE,
  observed_at TEXT NOT NULL,
  source_id   TEXT NOT NULL,
  amount      INTEGER NOT NULL,
  currency    TEXT NOT NULL,
  base_amount INTEGER NOT NULL,
  rate        REAL NOT NULL,
  PRIMARY KEY (vehicle_id, observed_at, source_id)
) WITHOUT ROWID;
CREATE INDEX idx_snapshots_time ON price_snapshots (observed_at);

CREATE TABLE photos (
  vehicle_id TEXT NOT NULL REFERENCES vehicles (id) ON DELETE CASCADE,
  position   INTEGER NOT NULL,
  url        TEXT NOT NULL,
  local_path TEXT,
  width      INTEGER,
  height     INTEGER,
  PRIMARY KEY (vehicle_id, position)
) WITHOUT ROWID;

CREATE TABLE runs (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  source_id   TEXT NOT NULL,
  search_id   TEXT NOT NULL,
  started_at  TEXT NOT NULL,
  finished_at TEXT NOT NULL,
  fetched     INTEGER NOT NULL,
  kept        INTEGER NOT NULL,
  created     INTEGER NOT NULL,
  merged      INTEGER NOT NULL,
  delisted    INTEGER NOT NULL,
  status      TEXT NOT NULL,
  -- Whether the source was read to the end. A run stopped by its page limit or
  -- its deadline saw part of what the portal offered, so it must not start the
  -- window that keeps the source from being asked again.
  complete    INTEGER NOT NULL DEFAULT 1,
  note        TEXT
);
CREATE INDEX idx_runs_source ON runs (source_id, finished_at DESC);

CREATE TABLE fx_rates (
  day      TEXT NOT NULL,
  currency TEXT NOT NULL,
  rate     REAL NOT NULL,
  PRIMARY KEY (day, currency)
) WITHOUT ROWID;

-- Which sources are on has to be visible and changeable at runtime. An env var
-- alone makes an unconfigured install look like a broken one.
CREATE TABLE source_settings (
  id         TEXT PRIMARY KEY,
  enabled    INTEGER NOT NULL,
  updated_at TEXT NOT NULL
) WITHOUT ROWID;

-- Portals identify makes and models numerically. Translating a name costs a
-- request, and the answer is stable for months.
CREATE TABLE lookup_cache (
  key        TEXT PRIMARY KEY,
  value      TEXT,
  updated_at TEXT NOT NULL
) WITHOUT ROWID;
