CREATE TABLE IF NOT EXISTS playlists (
  id TEXT PRIMARY KEY,
  owner TEXT NOT NULL,
  name TEXT NOT NULL,
  items TEXT NOT NULL,
  created INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS playlists_owner ON playlists(owner, created);

CREATE TABLE IF NOT EXISTS oauth_flows (
  state TEXT PRIMARY KEY,
  challenge TEXT NOT NULL,
  expires INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS login_tickets (
  ticket TEXT PRIMARY KEY,
  challenge TEXT NOT NULL,
  user_id TEXT NOT NULL,
  user_name TEXT NOT NULL,
  expires INTEGER NOT NULL
);
