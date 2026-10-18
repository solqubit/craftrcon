CREATE TABLE servers (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE COLLATE NOCASE,
  host TEXT NOT NULL,
  rcon_port INTEGER NOT NULL DEFAULT 25575,
  rcon_password_enc TEXT NOT NULL,
  game_port INTEGER NOT NULL DEFAULT 25565,
  icon TEXT NOT NULL DEFAULT 'mountain',
  color TEXT NOT NULL DEFAULT 'emerald',
  created_at INTEGER,
  updated_at INTEGER
);

CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE sessions (
  id_hash TEXT PRIMARY KEY,
  created_at INTEGER,
  last_seen INTEGER
);

CREATE TABLE favorites (
  id INTEGER PRIMARY KEY,
  server_id INTEGER NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  label TEXT,
  command TEXT,
  position INTEGER
);

CREATE TABLE command_history (
  id INTEGER PRIMARY KEY,
  server_id INTEGER NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  command TEXT,
  ts INTEGER
);

CREATE TABLE tasks (
  id INTEGER PRIMARY KEY,
  server_id INTEGER NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  name TEXT,
  enabled INTEGER,
  trigger_type TEXT CHECK (trigger_type IN ('interval', 'daily')),
  interval_minutes INTEGER,
  daily_time TEXT,
  steps TEXT, -- JSON
  last_run_at INTEGER,
  next_run_at INTEGER
);

CREATE TABLE audit (
  id INTEGER PRIMARY KEY,
  ts INTEGER,
  server_id INTEGER REFERENCES servers(id) ON DELETE CASCADE,
  origin TEXT CHECK (origin IN ('console', 'ui', 'task', 'auth', 'system')),
  action TEXT,
  detail TEXT,
  ok INTEGER,
  result TEXT
);

CREATE TABLE player_samples (
  server_id INTEGER NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  ts INTEGER,
  online INTEGER,
  max INTEGER
);

CREATE INDEX idx_player_samples_server_ts ON player_samples (server_id, ts);
