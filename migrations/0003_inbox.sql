CREATE TABLE inbox_entries (
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
  content TEXT NOT NULL
    CHECK (
      length(content) BETWEEN 1 AND 500
      AND content = trim(content)
      AND instr(content, char(0)) = 0
    ),
  category TEXT NOT NULL DEFAULT 'uncategorized'
    CHECK (category IN ('uncategorized', 'task', 'note', 'link')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  archived_at TEXT,
  CHECK (updated_at >= created_at),
  CHECK (
    archived_at IS NULL
    OR (archived_at >= created_at AND updated_at >= archived_at)
  )
) STRICT;

CREATE INDEX inbox_active_workspace_order
  ON inbox_entries (workspace_id, created_at DESC, id DESC)
  WHERE archived_at IS NULL;

CREATE INDEX inbox_archive_order
  ON inbox_entries (workspace_id, archived_at DESC, id DESC)
  WHERE archived_at IS NOT NULL;

CREATE TRIGGER inbox_requires_active_workspace_insert
BEFORE INSERT ON inbox_entries
WHEN NOT EXISTS (
  SELECT 1 FROM workspaces
  WHERE id = NEW.workspace_id AND archived_at IS NULL
)
BEGIN
  SELECT RAISE(ABORT, 'inbox entry requires an active workspace');
END;

CREATE TRIGGER inbox_workspace_is_immutable
BEFORE UPDATE OF workspace_id ON inbox_entries
WHEN NEW.workspace_id <> OLD.workspace_id
BEGIN
  SELECT RAISE(ABORT, 'inbox entry workspace is immutable');
END;

CREATE TRIGGER inbox_prevent_archived_workspace_mutation
BEFORE UPDATE ON inbox_entries
WHEN EXISTS (
  SELECT 1 FROM workspaces
  WHERE id = OLD.workspace_id AND archived_at IS NOT NULL
)
BEGIN
  SELECT RAISE(ABORT, 'archived workspace inbox is immutable');
END;
