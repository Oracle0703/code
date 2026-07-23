CREATE TABLE browser_tabs (
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
  workspace_id TEXT NOT NULL
    REFERENCES workspaces(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  url TEXT NOT NULL
    CHECK (
      length(url) BETWEEN 1 AND 4096
      AND url = trim(url)
      AND instr(url, char(0)) = 0
      AND instr(url, char(10)) = 0
      AND instr(url, char(13)) = 0
      AND (
        url = 'about:blank'
        OR substr(url, 1, 7) = 'http://'
        OR substr(url, 1, 8) = 'https://'
      )
    ),
  title TEXT NOT NULL
    CHECK (
      length(title) BETWEEN 1 AND 512
      AND title = trim(title)
      AND instr(title, char(0)) = 0
      AND instr(title, char(10)) = 0
      AND instr(title, char(13)) = 0
    ),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (updated_at >= created_at),
  UNIQUE (workspace_id, id)
) STRICT;

CREATE INDEX browser_tabs_workspace_order
  ON browser_tabs (workspace_id, created_at, id);

CREATE TABLE browser_workspace_state (
  workspace_id TEXT PRIMARY KEY NOT NULL
    REFERENCES workspaces(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  active_tab_id TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1
    CHECK (revision BETWEEN 1 AND 9007199254740991),
  updated_at TEXT NOT NULL,
  FOREIGN KEY (workspace_id, active_tab_id)
    REFERENCES browser_tabs(workspace_id, id)
    ON UPDATE RESTRICT
    ON DELETE RESTRICT
) STRICT;

CREATE TABLE browser_bookmarks (
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
  workspace_id TEXT NOT NULL
    REFERENCES workspaces(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  url TEXT NOT NULL
    CHECK (
      length(url) BETWEEN 1 AND 4096
      AND url = trim(url)
      AND instr(url, char(0)) = 0
      AND instr(url, char(10)) = 0
      AND instr(url, char(13)) = 0
      AND (
        substr(url, 1, 7) = 'http://'
        OR substr(url, 1, 8) = 'https://'
      )
    ),
  title TEXT NOT NULL
    CHECK (
      length(title) BETWEEN 1 AND 512
      AND title = trim(title)
      AND instr(title, char(0)) = 0
      AND instr(title, char(10)) = 0
      AND instr(title, char(13)) = 0
    ),
  created_at TEXT NOT NULL,
  UNIQUE (workspace_id, url)
) STRICT;

CREATE INDEX browser_bookmarks_workspace_order
  ON browser_bookmarks (workspace_id, created_at, id);

CREATE TRIGGER browser_tabs_require_active_workspace_insert
BEFORE INSERT ON browser_tabs
WHEN NOT EXISTS (
  SELECT 1 FROM workspaces
  WHERE id = NEW.workspace_id AND archived_at IS NULL
)
BEGIN
  SELECT RAISE(ABORT, 'browser tab requires an active workspace');
END;

CREATE TRIGGER browser_tabs_limit_per_workspace
BEFORE INSERT ON browser_tabs
WHEN (
  SELECT COUNT(*) FROM browser_tabs
  WHERE workspace_id = NEW.workspace_id
) >= 12
BEGIN
  SELECT RAISE(ABORT, 'browser tab limit exceeded');
END;

CREATE TRIGGER browser_tabs_workspace_is_immutable
BEFORE UPDATE OF workspace_id ON browser_tabs
WHEN NEW.workspace_id <> OLD.workspace_id
BEGIN
  SELECT RAISE(ABORT, 'browser tab workspace is immutable');
END;

CREATE TRIGGER browser_tabs_created_at_is_immutable
BEFORE UPDATE OF created_at ON browser_tabs
WHEN NEW.created_at <> OLD.created_at
BEGIN
  SELECT RAISE(ABORT, 'browser tab creation time is immutable');
END;

CREATE TRIGGER browser_tabs_updated_at_must_not_rewind
BEFORE UPDATE OF updated_at ON browser_tabs
WHEN NEW.updated_at < OLD.updated_at
BEGIN
  SELECT RAISE(ABORT, 'browser tab update time cannot move backwards');
END;

CREATE TRIGGER browser_tabs_prevent_archived_workspace_mutation
BEFORE UPDATE ON browser_tabs
WHEN EXISTS (
  SELECT 1 FROM workspaces
  WHERE id = OLD.workspace_id AND archived_at IS NOT NULL
)
BEGIN
  SELECT RAISE(ABORT, 'archived workspace browser tabs are immutable');
END;

CREATE TRIGGER browser_tabs_prevent_archived_workspace_delete
BEFORE DELETE ON browser_tabs
WHEN EXISTS (
  SELECT 1 FROM workspaces
  WHERE id = OLD.workspace_id AND archived_at IS NOT NULL
)
BEGIN
  SELECT RAISE(ABORT, 'archived workspace browser tabs are immutable');
END;

CREATE TRIGGER browser_state_require_active_workspace_insert
BEFORE INSERT ON browser_workspace_state
WHEN NOT EXISTS (
  SELECT 1 FROM workspaces
  WHERE id = NEW.workspace_id AND archived_at IS NULL
)
BEGIN
  SELECT RAISE(ABORT, 'browser state requires an active workspace');
END;

CREATE TRIGGER browser_state_workspace_is_immutable
BEFORE UPDATE OF workspace_id ON browser_workspace_state
WHEN NEW.workspace_id <> OLD.workspace_id
BEGIN
  SELECT RAISE(ABORT, 'browser state workspace is immutable');
END;

CREATE TRIGGER browser_state_revision_must_advance
BEFORE UPDATE ON browser_workspace_state
WHEN NEW.revision <> OLD.revision + 1
BEGIN
  SELECT RAISE(ABORT, 'browser state revision must advance exactly once');
END;

CREATE TRIGGER browser_state_updated_at_must_not_rewind
BEFORE UPDATE OF updated_at ON browser_workspace_state
WHEN NEW.updated_at < OLD.updated_at
BEGIN
  SELECT RAISE(ABORT, 'browser state update time cannot move backwards');
END;

CREATE TRIGGER browser_state_prevent_archived_workspace_mutation
BEFORE UPDATE ON browser_workspace_state
WHEN EXISTS (
  SELECT 1 FROM workspaces
  WHERE id = OLD.workspace_id AND archived_at IS NOT NULL
)
BEGIN
  SELECT RAISE(ABORT, 'archived workspace browser state is immutable');
END;

CREATE TRIGGER browser_state_prevent_delete
BEFORE DELETE ON browser_workspace_state
BEGIN
  SELECT RAISE(ABORT, 'browser state cannot be deleted');
END;

CREATE TRIGGER browser_bookmarks_require_active_workspace_insert
BEFORE INSERT ON browser_bookmarks
WHEN NOT EXISTS (
  SELECT 1 FROM workspaces
  WHERE id = NEW.workspace_id AND archived_at IS NULL
)
BEGIN
  SELECT RAISE(ABORT, 'browser bookmark requires an active workspace');
END;

CREATE TRIGGER browser_bookmarks_limit_per_workspace
BEFORE INSERT ON browser_bookmarks
WHEN (
  SELECT COUNT(*) FROM browser_bookmarks
  WHERE workspace_id = NEW.workspace_id
) >= 500
BEGIN
  SELECT RAISE(ABORT, 'browser bookmark limit exceeded');
END;

CREATE TRIGGER browser_bookmarks_workspace_is_immutable
BEFORE UPDATE OF workspace_id ON browser_bookmarks
WHEN NEW.workspace_id <> OLD.workspace_id
BEGIN
  SELECT RAISE(ABORT, 'browser bookmark workspace is immutable');
END;

CREATE TRIGGER browser_bookmarks_row_is_immutable
BEFORE UPDATE ON browser_bookmarks
BEGIN
  SELECT RAISE(ABORT, 'browser bookmark rows are immutable');
END;

CREATE TRIGGER browser_bookmarks_prevent_archived_workspace_mutation
BEFORE UPDATE ON browser_bookmarks
WHEN EXISTS (
  SELECT 1 FROM workspaces
  WHERE id = OLD.workspace_id AND archived_at IS NOT NULL
)
BEGIN
  SELECT RAISE(ABORT, 'archived workspace browser bookmarks are immutable');
END;

CREATE TRIGGER browser_bookmarks_prevent_archived_workspace_delete
BEFORE DELETE ON browser_bookmarks
WHEN EXISTS (
  SELECT 1 FROM workspaces
  WHERE id = OLD.workspace_id AND archived_at IS NOT NULL
)
BEGIN
  SELECT RAISE(ABORT, 'archived workspace browser bookmarks are immutable');
END;
