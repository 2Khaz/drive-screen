CREATE TABLE IF NOT EXISTS audio_covers (
  owner TEXT NOT NULL,
  file_id TEXT NOT NULL,
  image TEXT NOT NULL,
  mime TEXT NOT NULL,
  updated INTEGER NOT NULL,
  PRIMARY KEY (owner, file_id)
);
