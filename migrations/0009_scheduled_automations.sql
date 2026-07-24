CREATE TABLE automations (
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
  name TEXT NOT NULL
    CHECK (
      length(name) BETWEEN 1 AND 120
      AND name = trim(name)
      AND instr(name, char(0)) = 0
      AND instr(name, char(10)) = 0
      AND instr(name, char(13)) = 0
    ),
  cadence TEXT NOT NULL
    CHECK (cadence IN ('daily', 'weekly')),
  local_time_minute INTEGER NOT NULL
    CHECK (local_time_minute BETWEEN 0 AND 1439),
  weekday INTEGER
    CHECK (weekday IS NULL OR weekday BETWEEN 0 AND 6),
  action_kind TEXT NOT NULL
    CHECK (action_kind IN ('create-today-task', 'create-note')),
  action_title TEXT NOT NULL
    CHECK (
      length(action_title) BETWEEN 1 AND 500
      AND action_title = trim(action_title)
      AND instr(action_title, char(0)) = 0
      AND instr(action_title, char(10)) = 0
      AND instr(action_title, char(13)) = 0
    ),
  action_body TEXT
    CHECK (
      action_body IS NULL
      OR (
        length(action_body) <= 100000
        AND instr(action_body, char(0)) = 0
        AND instr(action_body, char(13)) = 0
      )
    ),
  enabled INTEGER NOT NULL DEFAULT 0
    CHECK (enabled IN (0, 1)),
  effective_at TEXT,
  revision INTEGER NOT NULL DEFAULT 1
    CHECK (revision BETWEEN 1 AND 9007199254740991),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  archived_at TEXT,
  CHECK (
    (cadence = 'daily' AND weekday IS NULL)
    OR (cadence = 'weekly' AND weekday IS NOT NULL)
  ),
  CHECK (
    (action_kind = 'create-today-task' AND length(action_title) <= 500 AND action_body IS NULL)
    OR (
      action_kind = 'create-note'
      AND length(action_title) <= 200
      AND action_body IS NOT NULL
    )
  ),
  CHECK (
    (enabled = 0 AND effective_at IS NULL)
    OR (enabled = 1 AND effective_at IS NOT NULL)
  ),
  CHECK (updated_at >= created_at),
  CHECK (
    archived_at IS NULL
    OR (enabled = 0 AND archived_at >= created_at AND updated_at >= archived_at)
  )
) STRICT;

CREATE INDEX automations_active_workspace_order
  ON automations (workspace_id, enabled DESC, updated_at DESC, id DESC)
  WHERE archived_at IS NULL;

CREATE INDEX automations_enabled_schedule
  ON automations (cadence, weekday, local_time_minute, id)
  WHERE enabled = 1 AND archived_at IS NULL;

CREATE TABLE automation_run_state (
  automation_id TEXT PRIMARY KEY NOT NULL
    REFERENCES automations(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  last_attempt_at TEXT,
  last_attempt_occurrence TEXT,
  last_success_at TEXT,
  last_success_occurrence TEXT,
  last_output_kind TEXT
    CHECK (last_output_kind IS NULL OR last_output_kind IN ('task', 'note')),
  last_error_code TEXT
    CHECK (
      last_error_code IS NULL
      OR last_error_code IN ('action-failed', 'database-unavailable', 'workspace-unavailable')
    ),
  consecutive_failures INTEGER NOT NULL DEFAULT 0
    CHECK (consecutive_failures BETWEEN 0 AND 9007199254740991),
  next_retry_at TEXT,
  updated_at TEXT NOT NULL,
  CHECK (
    (last_attempt_at IS NULL AND last_attempt_occurrence IS NULL)
    OR (last_attempt_at IS NOT NULL AND last_attempt_occurrence IS NOT NULL)
  ),
  CHECK (
    (last_success_at IS NULL AND last_success_occurrence IS NULL AND last_output_kind IS NULL)
    OR (last_success_at IS NOT NULL AND last_success_occurrence IS NOT NULL AND last_output_kind IS NOT NULL)
  ),
  CHECK (
    (last_error_code IS NULL AND consecutive_failures = 0 AND next_retry_at IS NULL)
    OR (last_error_code IS NOT NULL AND consecutive_failures > 0 AND next_retry_at IS NOT NULL)
  )
) STRICT;

CREATE TABLE automation_occurrences (
  automation_id TEXT NOT NULL
    REFERENCES automations(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  occurrence_date TEXT NOT NULL
    CHECK (
      length(occurrence_date) = 10
      AND substr(occurrence_date, 5, 1) = '-'
      AND substr(occurrence_date, 8, 1) = '-'
      AND occurrence_date NOT GLOB '*[^0-9-]*'
      AND substr(occurrence_date, 1, 4) BETWEEN '0001' AND '9999'
      AND date(occurrence_date) IS NOT NULL
      AND date(occurrence_date) = occurrence_date
    ),
  scheduled_for TEXT NOT NULL,
  definition_revision INTEGER NOT NULL
    CHECK (definition_revision BETWEEN 1 AND 9007199254740991),
  completed_at TEXT NOT NULL,
  output_kind TEXT NOT NULL
    CHECK (output_kind IN ('task', 'note')),
  task_id TEXT
    REFERENCES tasks(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  note_id TEXT
    REFERENCES notes(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  PRIMARY KEY (automation_id, occurrence_date),
  CHECK (
    (output_kind = 'task' AND task_id IS NOT NULL AND note_id IS NULL)
    OR (output_kind = 'note' AND task_id IS NULL AND note_id IS NOT NULL)
  ),
  CHECK (completed_at >= scheduled_for)
) STRICT, WITHOUT ROWID;

CREATE INDEX automation_occurrences_completion_order
  ON automation_occurrences (completed_at DESC, automation_id, occurrence_date);

CREATE TRIGGER automations_require_active_workspace_insert
BEFORE INSERT ON automations
WHEN NOT EXISTS (
  SELECT 1 FROM workspaces
  WHERE id = NEW.workspace_id AND archived_at IS NULL
)
BEGIN
  SELECT RAISE(ABORT, 'automation requires an active workspace');
END;

CREATE TRIGGER automations_global_active_limit_insert
BEFORE INSERT ON automations
WHEN NEW.archived_at IS NULL
  AND (
  SELECT COUNT(*)
  FROM automations AS automation
  JOIN workspaces AS workspace ON workspace.id = automation.workspace_id
  WHERE automation.archived_at IS NULL AND workspace.archived_at IS NULL
) >= 100
BEGIN
  SELECT RAISE(ABORT, 'active automation limit reached');
END;

CREATE TRIGGER automations_enabled_workspace_limit_insert
BEFORE INSERT ON automations
WHEN NEW.enabled = 1
  AND (
    SELECT COUNT(*)
    FROM automations
    WHERE workspace_id = NEW.workspace_id
      AND enabled = 1
      AND archived_at IS NULL
  ) >= 25
BEGIN
  SELECT RAISE(ABORT, 'workspace enabled automation limit reached');
END;

CREATE TRIGGER automations_enabled_workspace_limit_update
BEFORE UPDATE OF enabled ON automations
WHEN OLD.enabled = 0
  AND NEW.enabled = 1
  AND (
    SELECT COUNT(*)
    FROM automations
    WHERE workspace_id = NEW.workspace_id
      AND enabled = 1
      AND archived_at IS NULL
      AND id <> NEW.id
  ) >= 25
BEGIN
  SELECT RAISE(ABORT, 'workspace enabled automation limit reached');
END;

CREATE TRIGGER automations_workspace_is_immutable
BEFORE UPDATE OF workspace_id ON automations
WHEN NEW.workspace_id <> OLD.workspace_id
BEGIN
  SELECT RAISE(ABORT, 'automation workspace is immutable');
END;

CREATE TRIGGER automations_action_kind_is_immutable
BEFORE UPDATE OF action_kind ON automations
WHEN NEW.action_kind <> OLD.action_kind
BEGIN
  SELECT RAISE(ABORT, 'automation action kind is immutable');
END;

CREATE TRIGGER automations_revision_must_advance
BEFORE UPDATE ON automations
WHEN NEW.revision <> OLD.revision + 1
BEGIN
  SELECT RAISE(ABORT, 'automation revision must advance exactly once');
END;

CREATE TRIGGER automations_updated_at_must_not_rewind
BEFORE UPDATE OF updated_at ON automations
WHEN NEW.updated_at < OLD.updated_at
BEGIN
  SELECT RAISE(ABORT, 'automation update time cannot move backwards');
END;

CREATE TRIGGER automations_archived_row_is_immutable
BEFORE UPDATE ON automations
WHEN OLD.archived_at IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'archived automation is immutable');
END;

CREATE TRIGGER automations_prevent_archived_workspace_mutation
BEFORE UPDATE ON automations
WHEN EXISTS (
  SELECT 1 FROM workspaces
  WHERE id = OLD.workspace_id AND archived_at IS NOT NULL
)
BEGIN
  SELECT RAISE(ABORT, 'archived workspace automations are immutable');
END;

CREATE TRIGGER automations_prevent_delete
BEFORE DELETE ON automations
BEGIN
  SELECT RAISE(ABORT, 'automations cannot be permanently deleted');
END;

CREATE TRIGGER automation_run_state_create_after_automation
AFTER INSERT ON automations
BEGIN
  INSERT INTO automation_run_state (
    automation_id,
    last_attempt_at,
    last_attempt_occurrence,
    last_success_at,
    last_success_occurrence,
    last_output_kind,
    last_error_code,
    consecutive_failures,
    next_retry_at,
    updated_at
  ) VALUES (
    NEW.id,
    NULL,
    NULL,
    NULL,
    NULL,
    NULL,
    NULL,
    0,
    NULL,
    NEW.created_at
  );
END;

CREATE TRIGGER automation_run_state_automation_is_immutable
BEFORE UPDATE OF automation_id ON automation_run_state
WHEN NEW.automation_id <> OLD.automation_id
BEGIN
  SELECT RAISE(ABORT, 'automation run-state owner is immutable');
END;

CREATE TRIGGER automation_run_state_updated_at_must_not_rewind
BEFORE UPDATE OF updated_at ON automation_run_state
WHEN NEW.updated_at < OLD.updated_at
BEGIN
  SELECT RAISE(ABORT, 'automation run-state time cannot move backwards');
END;

CREATE TRIGGER automation_run_state_prevent_delete
BEFORE DELETE ON automation_run_state
BEGIN
  SELECT RAISE(ABORT, 'automation run state cannot be deleted');
END;

CREATE TRIGGER automation_occurrences_validate_output_workspace
BEFORE INSERT ON automation_occurrences
WHEN (
  NEW.output_kind = 'task'
  AND NOT EXISTS (
    SELECT 1
    FROM tasks AS task
    JOIN automations AS automation ON automation.id = NEW.automation_id
    WHERE task.id = NEW.task_id
      AND task.workspace_id = automation.workspace_id
      AND automation.action_kind = 'create-today-task'
      AND NEW.definition_revision <= automation.revision
  )
) OR (
  NEW.output_kind = 'note'
  AND NOT EXISTS (
    SELECT 1
    FROM notes AS note
    JOIN automations AS automation ON automation.id = NEW.automation_id
    WHERE note.id = NEW.note_id
      AND note.workspace_id = automation.workspace_id
      AND automation.action_kind = 'create-note'
      AND NEW.definition_revision <= automation.revision
  )
)
BEGIN
  SELECT RAISE(ABORT, 'automation output does not match its workspace or action');
END;

CREATE TRIGGER automation_occurrences_prevent_update
BEFORE UPDATE ON automation_occurrences
BEGIN
  SELECT RAISE(ABORT, 'automation occurrences are immutable');
END;

CREATE TRIGGER automation_occurrences_prevent_delete
BEFORE DELETE ON automation_occurrences
BEGIN
  SELECT RAISE(ABORT, 'automation occurrences cannot be deleted');
END;

CREATE TRIGGER workspace_automations_disable_before_archive
BEFORE UPDATE OF archived_at ON workspaces
WHEN OLD.archived_at IS NULL AND NEW.archived_at IS NOT NULL
BEGIN
  UPDATE automations
  SET enabled = 0,
      effective_at = NULL,
      revision = revision + 1,
      updated_at = CASE
        WHEN updated_at > NEW.updated_at THEN updated_at
        ELSE NEW.updated_at
      END
  WHERE workspace_id = OLD.id
    AND enabled = 1
    AND archived_at IS NULL;
END;
