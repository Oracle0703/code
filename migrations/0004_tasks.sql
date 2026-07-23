CREATE UNIQUE INDEX inbox_workspace_entry_identity
  ON inbox_entries (workspace_id, id);

CREATE TABLE tasks (
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
      length(title) BETWEEN 1 AND 500
      AND title = trim(title)
      AND instr(title, char(0)) = 0
    ),
  status TEXT NOT NULL DEFAULT 'todo'
    CHECK (status IN ('todo', 'in_progress', 'completed')),
  planned_for TEXT
    CHECK (
      planned_for IS NULL
      OR (
        length(planned_for) = 10
        AND substr(planned_for, 5, 1) = '-'
        AND substr(planned_for, 8, 1) = '-'
        AND planned_for NOT GLOB '*[^0-9-]*'
        AND substr(planned_for, 1, 4) BETWEEN '0001' AND '9999'
        AND date(planned_for) IS NOT NULL
        AND date(planned_for) = planned_for
      )
    ),
  source_inbox_entry_id TEXT UNIQUE,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT,
  FOREIGN KEY (workspace_id, source_inbox_entry_id)
    REFERENCES inbox_entries(workspace_id, id)
    ON UPDATE RESTRICT
    ON DELETE RESTRICT,
  CHECK (updated_at >= created_at),
  CHECK (
    (status = 'completed' AND completed_at IS NOT NULL)
    OR (status <> 'completed' AND completed_at IS NULL)
  ),
  CHECK (
    completed_at IS NULL
    OR (completed_at >= created_at AND updated_at >= completed_at)
  )
) STRICT;

CREATE INDEX tasks_workspace_order
  ON tasks (workspace_id, created_at DESC, id DESC);

CREATE INDEX tasks_workspace_status_order
  ON tasks (workspace_id, status, updated_at DESC, id DESC);

CREATE INDEX tasks_workspace_plan_order
  ON tasks (workspace_id, planned_for, status, created_at DESC, id DESC)
  WHERE planned_for IS NOT NULL;

CREATE TRIGGER tasks_require_active_workspace_insert
BEFORE INSERT ON tasks
WHEN NOT EXISTS (
  SELECT 1 FROM workspaces
  WHERE id = NEW.workspace_id AND archived_at IS NULL
)
BEGIN
  SELECT RAISE(ABORT, 'task requires an active workspace');
END;

CREATE TRIGGER tasks_workspace_is_immutable
BEFORE UPDATE OF workspace_id ON tasks
WHEN NEW.workspace_id <> OLD.workspace_id
BEGIN
  SELECT RAISE(ABORT, 'task workspace is immutable');
END;

CREATE TRIGGER tasks_source_is_immutable
BEFORE UPDATE OF source_inbox_entry_id ON tasks
WHEN NEW.source_inbox_entry_id IS NOT OLD.source_inbox_entry_id
BEGIN
  SELECT RAISE(ABORT, 'task inbox source is immutable');
END;

CREATE TRIGGER tasks_require_archived_inbox_source_insert
BEFORE INSERT ON tasks
WHEN NEW.source_inbox_entry_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM inbox_entries
    WHERE workspace_id = NEW.workspace_id
      AND id = NEW.source_inbox_entry_id
      AND archived_at IS NOT NULL
  )
BEGIN
  SELECT RAISE(ABORT, 'task inbox source must be archived');
END;

CREATE TRIGGER tasks_prevent_archived_workspace_mutation
BEFORE UPDATE ON tasks
WHEN EXISTS (
  SELECT 1 FROM workspaces
  WHERE id = OLD.workspace_id AND archived_at IS NOT NULL
)
BEGIN
  SELECT RAISE(ABORT, 'archived workspace tasks are immutable');
END;

CREATE TRIGGER tasks_prevent_archived_workspace_delete
BEFORE DELETE ON tasks
WHEN EXISTS (
  SELECT 1 FROM workspaces
  WHERE id = OLD.workspace_id AND archived_at IS NOT NULL
)
BEGIN
  SELECT RAISE(ABORT, 'archived workspace tasks are immutable');
END;

CREATE TRIGGER inbox_prevent_linked_task_source_restore
BEFORE UPDATE OF archived_at ON inbox_entries
WHEN OLD.archived_at IS NOT NULL
  AND NEW.archived_at IS NULL
  AND EXISTS (
    SELECT 1 FROM tasks
    WHERE source_inbox_entry_id = OLD.id
      AND workspace_id = OLD.workspace_id
  )
BEGIN
  SELECT RAISE(ABORT, 'task inbox source must remain archived');
END;
