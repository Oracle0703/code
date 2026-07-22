CREATE TABLE app_metadata (
  key TEXT PRIMARY KEY NOT NULL CHECK (length(key) BETWEEN 1 AND 80),
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;
