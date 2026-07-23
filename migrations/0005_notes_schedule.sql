CREATE TABLE notes (
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
  title TEXT NOT NULL
    CHECK (
      length(title) BETWEEN 1 AND 200
      AND title = trim(title)
      AND instr(title, char(0)) = 0
      AND instr(title, char(10)) = 0
      AND instr(title, char(13)) = 0
    ),
  body TEXT NOT NULL
    CHECK (
      length(body) <= 100000
      AND instr(body, char(0)) = 0
      AND instr(body, char(13)) = 0
    ),
  revision INTEGER NOT NULL DEFAULT 1
    CHECK (revision BETWEEN 1 AND 9007199254740991),
  source_inbox_entry_id TEXT UNIQUE,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  archived_at TEXT,
  FOREIGN KEY (workspace_id, source_inbox_entry_id)
    REFERENCES inbox_entries(workspace_id, id)
    ON UPDATE RESTRICT
    ON DELETE RESTRICT,
  CHECK (updated_at >= created_at),
  CHECK (
    archived_at IS NULL
    OR (archived_at >= created_at AND updated_at >= archived_at)
  )
) STRICT;

CREATE INDEX notes_active_workspace_order
  ON notes (workspace_id, updated_at DESC, id DESC)
  WHERE archived_at IS NULL;

CREATE INDEX notes_archive_order
  ON notes (workspace_id, archived_at DESC, id DESC)
  WHERE archived_at IS NOT NULL;

CREATE TRIGGER notes_require_active_workspace_insert
BEFORE INSERT ON notes
WHEN NOT EXISTS (
  SELECT 1 FROM workspaces
  WHERE id = NEW.workspace_id AND archived_at IS NULL
)
BEGIN
  SELECT RAISE(ABORT, 'note requires an active workspace');
END;

CREATE TRIGGER notes_workspace_is_immutable
BEFORE UPDATE OF workspace_id ON notes
WHEN NEW.workspace_id <> OLD.workspace_id
BEGIN
  SELECT RAISE(ABORT, 'note workspace is immutable');
END;

CREATE TRIGGER notes_source_is_immutable
BEFORE UPDATE OF source_inbox_entry_id ON notes
WHEN NEW.source_inbox_entry_id IS NOT OLD.source_inbox_entry_id
BEGIN
  SELECT RAISE(ABORT, 'note inbox source is immutable');
END;

CREATE TRIGGER notes_revision_must_advance
BEFORE UPDATE ON notes
WHEN NEW.revision <> OLD.revision + 1
BEGIN
  SELECT RAISE(ABORT, 'note revision must advance exactly once');
END;

CREATE TRIGGER notes_archived_row_is_immutable
BEFORE UPDATE ON notes
WHEN OLD.archived_at IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'archived note is immutable');
END;

CREATE TRIGGER notes_require_archived_inbox_source_insert
BEFORE INSERT ON notes
WHEN NEW.source_inbox_entry_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM inbox_entries
    WHERE workspace_id = NEW.workspace_id
      AND id = NEW.source_inbox_entry_id
      AND archived_at IS NOT NULL
  )
BEGIN
  SELECT RAISE(ABORT, 'note inbox source must be archived');
END;

CREATE TRIGGER notes_prevent_task_source_reuse
BEFORE INSERT ON notes
WHEN NEW.source_inbox_entry_id IS NOT NULL
  AND EXISTS (
    SELECT 1 FROM tasks
    WHERE source_inbox_entry_id = NEW.source_inbox_entry_id
      AND workspace_id = NEW.workspace_id
  )
BEGIN
  SELECT RAISE(ABORT, 'inbox source is already linked to a task');
END;

CREATE TRIGGER tasks_prevent_note_source_reuse
BEFORE INSERT ON tasks
WHEN NEW.source_inbox_entry_id IS NOT NULL
  AND EXISTS (
    SELECT 1 FROM notes
    WHERE source_inbox_entry_id = NEW.source_inbox_entry_id
      AND workspace_id = NEW.workspace_id
  )
BEGIN
  SELECT RAISE(ABORT, 'inbox source is already linked to a note');
END;

CREATE TRIGGER notes_prevent_archived_workspace_mutation
BEFORE UPDATE ON notes
WHEN EXISTS (
  SELECT 1 FROM workspaces
  WHERE id = OLD.workspace_id AND archived_at IS NOT NULL
)
BEGIN
  SELECT RAISE(ABORT, 'archived workspace notes are immutable');
END;

CREATE TRIGGER notes_prevent_delete
BEFORE DELETE ON notes
BEGIN
  SELECT RAISE(ABORT, 'notes cannot be permanently deleted');
END;

CREATE TRIGGER inbox_prevent_linked_note_source_restore
BEFORE UPDATE OF archived_at ON inbox_entries
WHEN OLD.archived_at IS NOT NULL
  AND NEW.archived_at IS NULL
  AND EXISTS (
    SELECT 1 FROM notes
    WHERE source_inbox_entry_id = OLD.id
      AND workspace_id = OLD.workspace_id
  )
BEGIN
  SELECT RAISE(ABORT, 'note inbox source must remain archived');
END;

CREATE TABLE schedule_items (
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
  title TEXT NOT NULL
    CHECK (
      length(title) BETWEEN 1 AND 200
      AND title = trim(title)
      AND instr(title, char(0)) = 0
      AND instr(title, char(10)) = 0
      AND instr(title, char(13)) = 0
    ),
  kind TEXT NOT NULL DEFAULT 'focus'
    CHECK (kind IN ('focus', 'meeting', 'review', 'personal')),
  scheduled_for TEXT NOT NULL
    CHECK (
      length(scheduled_for) = 10
      AND substr(scheduled_for, 5, 1) = '-'
      AND substr(scheduled_for, 8, 1) = '-'
      AND scheduled_for NOT GLOB '*[^0-9-]*'
      AND substr(scheduled_for, 1, 4) BETWEEN '0001' AND '9999'
      AND date(scheduled_for) IS NOT NULL
      AND date(scheduled_for) = scheduled_for
    ),
  start_minute INTEGER NOT NULL
    CHECK (start_minute BETWEEN 0 AND 1439),
  end_minute INTEGER NOT NULL
    CHECK (end_minute BETWEEN 1 AND 1440 AND end_minute > start_minute),
  revision INTEGER NOT NULL DEFAULT 1
    CHECK (revision BETWEEN 1 AND 9007199254740991),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  archived_at TEXT,
  CHECK (updated_at >= created_at),
  CHECK (
    archived_at IS NULL
    OR (archived_at >= created_at AND updated_at >= archived_at)
  )
) STRICT;

CREATE INDEX schedule_active_workspace_day_order
  ON schedule_items (workspace_id, scheduled_for, start_minute, end_minute, id)
  WHERE archived_at IS NULL;

CREATE INDEX schedule_archive_order
  ON schedule_items (workspace_id, archived_at DESC, id DESC)
  WHERE archived_at IS NOT NULL;

CREATE TRIGGER schedule_requires_active_workspace_insert
BEFORE INSERT ON schedule_items
WHEN NOT EXISTS (
  SELECT 1 FROM workspaces
  WHERE id = NEW.workspace_id AND archived_at IS NULL
)
BEGIN
  SELECT RAISE(ABORT, 'schedule item requires an active workspace');
END;

CREATE TRIGGER schedule_workspace_is_immutable
BEFORE UPDATE OF workspace_id ON schedule_items
WHEN NEW.workspace_id <> OLD.workspace_id
BEGIN
  SELECT RAISE(ABORT, 'schedule item workspace is immutable');
END;

CREATE TRIGGER schedule_date_is_immutable
BEFORE UPDATE OF scheduled_for ON schedule_items
WHEN NEW.scheduled_for <> OLD.scheduled_for
BEGIN
  SELECT RAISE(ABORT, 'schedule item date is immutable');
END;

CREATE TRIGGER schedule_revision_must_advance
BEFORE UPDATE ON schedule_items
WHEN NEW.revision <> OLD.revision + 1
BEGIN
  SELECT RAISE(ABORT, 'schedule revision must advance exactly once');
END;

CREATE TRIGGER schedule_archived_row_is_immutable
BEFORE UPDATE ON schedule_items
WHEN OLD.archived_at IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'archived schedule item is immutable');
END;

CREATE TRIGGER schedule_prevent_archived_workspace_mutation
BEFORE UPDATE ON schedule_items
WHEN EXISTS (
  SELECT 1 FROM workspaces
  WHERE id = OLD.workspace_id AND archived_at IS NOT NULL
)
BEGIN
  SELECT RAISE(ABORT, 'archived workspace schedule is immutable');
END;

CREATE TRIGGER schedule_prevent_delete
BEFORE DELETE ON schedule_items
BEGIN
  SELECT RAISE(ABORT, 'schedule items cannot be permanently deleted');
END;
