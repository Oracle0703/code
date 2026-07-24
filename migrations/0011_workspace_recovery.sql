CREATE TABLE workspace_recovery_revisions (
  workspace_id TEXT PRIMARY KEY NOT NULL
    REFERENCES workspaces(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  revision INTEGER NOT NULL DEFAULT 1
    CHECK (revision BETWEEN 1 AND 9007199254740991)
) STRICT, WITHOUT ROWID;

CREATE TRIGGER workspace_recovery_revision_create_after_workspace
AFTER INSERT ON workspaces
BEGIN
  INSERT INTO workspace_recovery_revisions (workspace_id, revision)
  VALUES (NEW.id, 1);
END;

CREATE TRIGGER workspace_recovery_revision_workspace_is_immutable
BEFORE UPDATE OF workspace_id ON workspace_recovery_revisions
WHEN NEW.workspace_id <> OLD.workspace_id
BEGIN
  SELECT RAISE(ABORT, 'workspace recovery identity is immutable');
END;

CREATE TRIGGER workspace_recovery_revision_must_advance
BEFORE UPDATE OF revision ON workspace_recovery_revisions
WHEN NEW.revision <> OLD.revision + 1
  OR EXISTS (
    SELECT 1
    FROM workspaces
    WHERE id = OLD.workspace_id
      AND (
        (archived_at IS NULL AND NEW.revision % 2 = 0)
        OR (archived_at IS NOT NULL AND NEW.revision % 2 = 1)
      )
  )
BEGIN
  SELECT RAISE(ABORT, 'workspace recovery revision must match the archive transition');
END;

CREATE TRIGGER workspace_recovery_revision_prevent_delete
BEFORE DELETE ON workspace_recovery_revisions
BEGIN
  SELECT RAISE(ABORT, 'workspace recovery revision cannot be deleted');
END;

CREATE TRIGGER workspace_recovery_revision_advance_after_archive_change
AFTER UPDATE OF archived_at ON workspaces
WHEN (
  OLD.archived_at IS NULL AND NEW.archived_at IS NOT NULL
) OR (
  OLD.archived_at IS NOT NULL AND NEW.archived_at IS NULL
)
BEGIN
  UPDATE workspace_recovery_revisions
  SET revision = revision + 1
  WHERE workspace_id = OLD.id;
END;

CREATE TRIGGER workspaces_archived_row_is_immutable
BEFORE UPDATE ON workspaces
WHEN OLD.archived_at IS NOT NULL AND NEW.archived_at IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'archived workspace metadata is immutable');
END;

CREATE TRIGGER workspaces_timestamp_order_insert
BEFORE INSERT ON workspaces
WHEN NEW.updated_at < NEW.created_at
  OR (NEW.archived_at IS NOT NULL AND NEW.updated_at < NEW.archived_at)
BEGIN
  SELECT RAISE(ABORT, 'workspace timestamp order is invalid');
END;

CREATE TRIGGER workspaces_timestamp_order_update
BEFORE UPDATE ON workspaces
WHEN NEW.updated_at < NEW.created_at
  OR (NEW.archived_at IS NOT NULL AND NEW.updated_at < NEW.archived_at)
BEGIN
  SELECT RAISE(ABORT, 'workspace timestamp order is invalid');
END;

CREATE TRIGGER workspaces_updated_at_must_not_rewind
BEFORE UPDATE OF updated_at ON workspaces
WHEN NEW.updated_at < OLD.updated_at
BEGIN
  SELECT RAISE(ABORT, 'workspace update time cannot move backwards');
END;

CREATE TRIGGER workspace_restore_active_automation_limit
BEFORE UPDATE OF archived_at ON workspaces
WHEN OLD.archived_at IS NOT NULL
  AND NEW.archived_at IS NULL
  AND (
    (
      SELECT COUNT(*)
      FROM automations AS automation
      JOIN workspaces AS workspace ON workspace.id = automation.workspace_id
      WHERE automation.archived_at IS NULL
        AND workspace.archived_at IS NULL
    )
    +
    (
      SELECT COUNT(*)
      FROM automations
      WHERE workspace_id = OLD.id
        AND archived_at IS NULL
    )
  ) > 100
BEGIN
  SELECT RAISE(ABORT, 'restored workspace would exceed active automation limit');
END;

CREATE TRIGGER automation_run_state_prevent_archived_workspace_mutation
BEFORE UPDATE ON automation_run_state
WHEN EXISTS (
  SELECT 1
  FROM automations AS automation
  JOIN workspaces AS workspace ON workspace.id = automation.workspace_id
  WHERE automation.id = OLD.automation_id
    AND workspace.archived_at IS NOT NULL
)
BEGIN
  SELECT RAISE(ABORT, 'archived workspace automation state is immutable');
END;

CREATE TRIGGER automation_occurrences_require_active_workspace_insert
BEFORE INSERT ON automation_occurrences
WHEN NOT EXISTS (
  SELECT 1
  FROM automations AS automation
  JOIN workspaces AS workspace ON workspace.id = automation.workspace_id
  WHERE automation.id = NEW.automation_id
    AND workspace.archived_at IS NULL
)
BEGIN
  SELECT RAISE(ABORT, 'automation occurrence requires an active workspace');
END;

INSERT INTO workspace_recovery_revisions (workspace_id, revision)
SELECT id, CASE WHEN archived_at IS NULL THEN 1 ELSE 2 END
FROM workspaces;
