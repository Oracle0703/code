CREATE TABLE workspaces (
  id TEXT PRIMARY KEY NOT NULL
    CHECK (
      length(id) = 36
      AND lower(id) = id
      AND substr(id, 9, 1) = '-'
      AND substr(id, 14, 1) = '-'
      AND substr(id, 15, 1) = '4'
      AND substr(id, 19, 1) = '-'
      AND substr(id, 20, 1) IN ('8', '9', 'a', 'b')
      AND substr(id, 24, 1) = '-'
      AND length(replace(id, '-', '')) = 32
      AND replace(id, '-', '') NOT GLOB '*[^0-9a-f]*'
    ),
  name TEXT NOT NULL
    CHECK (length(name) BETWEEN 1 AND 80 AND name = trim(name)),
  name_key TEXT NOT NULL
    CHECK (length(name_key) BETWEEN 1 AND 160),
  color TEXT NOT NULL
    CHECK (color IN ('#7b6ee8', '#348bd4', '#2da77e', '#d97757', '#c6579a', '#b68b32')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  archived_at TEXT,
  -- Archive writes use max(current time, created_at, updated_at), so a system
  -- clock correction cannot violate this ordering invariant.
  CHECK (archived_at IS NULL OR archived_at >= created_at)
) STRICT;

CREATE UNIQUE INDEX workspaces_active_name_unique
  ON workspaces (name_key)
  WHERE archived_at IS NULL;

CREATE INDEX workspaces_archive_order
  ON workspaces (archived_at, created_at, id);

CREATE TABLE workspace_preferences (
  workspace_id TEXT PRIMARY KEY NOT NULL
    REFERENCES workspaces(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  active_view TEXT NOT NULL DEFAULT 'today'
    CHECK (active_view IN ('today', 'inbox', 'tasks', 'notes', 'automations', 'settings')),
  theme TEXT NOT NULL DEFAULT 'dark'
    CHECK (theme IN ('dark', 'light')),
  sidebar_collapsed INTEGER NOT NULL DEFAULT 0
    CHECK (sidebar_collapsed IN (0, 1)),
  browser_open INTEGER NOT NULL DEFAULT 1
    CHECK (browser_open IN (0, 1)),
  browser_width INTEGER NOT NULL DEFAULT 430
    CHECK (browser_width BETWEEN 340 AND 720),
  terminal_open INTEGER NOT NULL DEFAULT 1
    CHECK (terminal_open IN (0, 1)),
  terminal_height INTEGER NOT NULL DEFAULT 260
    CHECK (terminal_height BETWEEN 180 AND 2160),
  updated_at TEXT NOT NULL
) STRICT;

CREATE TABLE workspace_app_state (
  singleton INTEGER PRIMARY KEY NOT NULL DEFAULT 1 CHECK (singleton = 1),
  current_workspace_id TEXT NOT NULL
    REFERENCES workspaces(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  updated_at TEXT NOT NULL
) STRICT;

CREATE TRIGGER workspace_state_requires_active_insert
BEFORE INSERT ON workspace_app_state
WHEN EXISTS (
  SELECT 1 FROM workspaces
  WHERE id = NEW.current_workspace_id AND archived_at IS NOT NULL
)
BEGIN
  SELECT RAISE(ABORT, 'current workspace must be active');
END;

CREATE TRIGGER workspace_state_requires_active_update
BEFORE UPDATE OF current_workspace_id ON workspace_app_state
WHEN EXISTS (
  SELECT 1 FROM workspaces
  WHERE id = NEW.current_workspace_id AND archived_at IS NOT NULL
)
BEGIN
  SELECT RAISE(ABORT, 'current workspace must be active');
END;

CREATE TRIGGER workspace_prevent_current_archive
BEFORE UPDATE OF archived_at ON workspaces
WHEN NEW.archived_at IS NOT NULL
  AND OLD.archived_at IS NULL
  AND EXISTS (
    SELECT 1 FROM workspace_app_state
    WHERE current_workspace_id = OLD.id
  )
BEGIN
  SELECT RAISE(ABORT, 'current workspace must be switched before archive');
END;

CREATE TRIGGER workspace_prevent_last_active_archive
BEFORE UPDATE OF archived_at ON workspaces
WHEN NEW.archived_at IS NOT NULL
  AND OLD.archived_at IS NULL
  AND (SELECT COUNT(*) FROM workspaces WHERE archived_at IS NULL) <= 1
BEGIN
  SELECT RAISE(ABORT, 'at least one active workspace is required');
END;
