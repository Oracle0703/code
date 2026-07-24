CREATE TABLE focus_sessions (
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
  task_id TEXT
    REFERENCES tasks(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  local_date TEXT NOT NULL
    CHECK (
      length(local_date) = 10
      AND substr(local_date, 5, 1) = '-'
      AND substr(local_date, 8, 1) = '-'
      AND local_date NOT GLOB '*[^0-9-]*'
      AND substr(local_date, 1, 4) BETWEEN '0001' AND '9999'
      AND date(local_date) IS NOT NULL
      AND date(local_date) = local_date
    ),
  state TEXT NOT NULL
    CHECK (state IN ('running', 'paused', 'completed', 'cancelled')),
  remaining_seconds INTEGER NOT NULL
    CHECK (remaining_seconds BETWEEN 0 AND 1500),
  deadline_at TEXT,
  revision INTEGER NOT NULL DEFAULT 1
    CHECK (revision BETWEEN 1 AND 9007199254740991),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT,
  cancelled_at TEXT,
  CHECK (updated_at >= created_at),
  CHECK (
    (state = 'running'
      AND remaining_seconds BETWEEN 1 AND 1500
      AND deadline_at IS NOT NULL
      AND completed_at IS NULL
      AND cancelled_at IS NULL)
    OR
    (state = 'paused'
      AND remaining_seconds BETWEEN 1 AND 1500
      AND deadline_at IS NULL
      AND completed_at IS NULL
      AND cancelled_at IS NULL)
    OR
    (state = 'completed'
      AND remaining_seconds = 0
      AND deadline_at IS NULL
      AND completed_at IS NOT NULL
      AND completed_at >= created_at
      AND updated_at >= completed_at
      AND cancelled_at IS NULL)
    OR
    (state = 'cancelled'
      AND deadline_at IS NULL
      AND completed_at IS NULL
      AND cancelled_at IS NOT NULL
      AND cancelled_at >= created_at
      AND updated_at >= cancelled_at)
  )
) STRICT;

CREATE UNIQUE INDEX focus_sessions_single_open
  ON focus_sessions ((1))
  WHERE state IN ('running', 'paused');

CREATE INDEX focus_sessions_workspace_history
  ON focus_sessions (workspace_id, created_at DESC, id DESC);

CREATE INDEX focus_sessions_workspace_day_state
  ON focus_sessions (workspace_id, local_date, state);

CREATE INDEX focus_sessions_task_history
  ON focus_sessions (task_id, created_at DESC, id DESC)
  WHERE task_id IS NOT NULL;

CREATE TRIGGER focus_sessions_require_active_workspace_insert
BEFORE INSERT ON focus_sessions
WHEN NOT EXISTS (
  SELECT 1 FROM workspaces
  WHERE id = NEW.workspace_id AND archived_at IS NULL
)
BEGIN
  SELECT RAISE(ABORT, 'focus session requires an active workspace');
END;

CREATE TRIGGER focus_sessions_validate_task_workspace_insert
BEFORE INSERT ON focus_sessions
WHEN NEW.task_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM tasks
    WHERE id = NEW.task_id AND workspace_id = NEW.workspace_id
  )
BEGIN
  SELECT RAISE(ABORT, 'focus session task must belong to its workspace');
END;

CREATE TRIGGER focus_sessions_workspace_is_immutable
BEFORE UPDATE OF workspace_id ON focus_sessions
WHEN NEW.workspace_id <> OLD.workspace_id
BEGIN
  SELECT RAISE(ABORT, 'focus session workspace is immutable');
END;

CREATE TRIGGER focus_sessions_task_is_immutable
BEFORE UPDATE OF task_id ON focus_sessions
WHEN NEW.task_id IS NOT OLD.task_id
BEGIN
  SELECT RAISE(ABORT, 'focus session task is immutable');
END;

CREATE TRIGGER focus_sessions_local_date_is_immutable
BEFORE UPDATE OF local_date ON focus_sessions
WHEN NEW.local_date <> OLD.local_date
BEGIN
  SELECT RAISE(ABORT, 'focus session local date is immutable');
END;

CREATE TRIGGER focus_sessions_created_at_is_immutable
BEFORE UPDATE OF created_at ON focus_sessions
WHEN NEW.created_at <> OLD.created_at
BEGIN
  SELECT RAISE(ABORT, 'focus session creation time is immutable');
END;

CREATE TRIGGER focus_sessions_revision_must_advance
BEFORE UPDATE ON focus_sessions
WHEN NEW.revision <> OLD.revision + 1
BEGIN
  SELECT RAISE(ABORT, 'focus session revision must advance exactly once');
END;

CREATE TRIGGER focus_sessions_updated_at_must_not_rewind
BEFORE UPDATE OF updated_at ON focus_sessions
WHEN NEW.updated_at < OLD.updated_at
BEGIN
  SELECT RAISE(ABORT, 'focus session update time cannot move backwards');
END;

CREATE TRIGGER focus_sessions_state_transition_is_valid
BEFORE UPDATE ON focus_sessions
WHEN NOT (
  (OLD.state = 'running'
    AND NEW.state = 'running'
    AND NEW.remaining_seconds < OLD.remaining_seconds
    AND NEW.deadline_at = OLD.deadline_at)
  OR
  (OLD.state = 'running'
    AND NEW.state IN ('paused', 'cancelled')
    AND NEW.remaining_seconds <= OLD.remaining_seconds)
  OR
  (OLD.state = 'running'
    AND NEW.state = 'completed')
  OR
  (OLD.state = 'paused'
    AND NEW.state = 'running'
    AND NEW.remaining_seconds = OLD.remaining_seconds)
  OR
  (OLD.state = 'paused'
    AND NEW.state = 'cancelled'
    AND NEW.remaining_seconds = OLD.remaining_seconds)
)
BEGIN
  SELECT RAISE(ABORT, 'focus session state transition is invalid');
END;

CREATE TRIGGER focus_sessions_terminal_row_is_immutable
BEFORE UPDATE ON focus_sessions
WHEN OLD.state IN ('completed', 'cancelled')
BEGIN
  SELECT RAISE(ABORT, 'terminal focus session is immutable');
END;

CREATE TRIGGER focus_sessions_prevent_archived_workspace_mutation
BEFORE UPDATE ON focus_sessions
WHEN EXISTS (
  SELECT 1 FROM workspaces
  WHERE id = OLD.workspace_id AND archived_at IS NOT NULL
)
BEGIN
  SELECT RAISE(ABORT, 'archived workspace focus sessions are immutable');
END;

CREATE TRIGGER focus_sessions_prevent_delete
BEFORE DELETE ON focus_sessions
BEGIN
  SELECT RAISE(ABORT, 'focus sessions cannot be permanently deleted');
END;

CREATE TRIGGER workspace_focus_session_cancel_before_archive
BEFORE UPDATE OF archived_at ON workspaces
WHEN OLD.archived_at IS NULL AND NEW.archived_at IS NOT NULL
BEGIN
  UPDATE focus_sessions
  SET state = 'cancelled',
      deadline_at = NULL,
      revision = revision + 1,
      updated_at = CASE
        WHEN updated_at > NEW.updated_at THEN updated_at
        ELSE NEW.updated_at
      END,
      cancelled_at = CASE
        WHEN updated_at > NEW.updated_at THEN updated_at
        ELSE NEW.updated_at
      END
  WHERE workspace_id = OLD.id
    AND state IN ('running', 'paused');
END;
