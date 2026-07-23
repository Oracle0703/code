CREATE TABLE workspace_terminal_preferences (
  workspace_id TEXT PRIMARY KEY NOT NULL
    REFERENCES workspaces(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  preferred_profile_id TEXT NOT NULL DEFAULT 'system-default'
    CHECK (
      preferred_profile_id IN (
        'system-default',
        'powershell-7',
        'windows-powershell',
        'command-prompt',
        'wsl-default',
        'bash',
        'zsh'
      )
    ),
  native_cwd_platform TEXT
    CHECK (
      native_cwd_platform IS NULL
      OR native_cwd_platform IN ('win32', 'darwin', 'linux')
    ),
  native_cwd_path TEXT
    CHECK (
      native_cwd_path IS NULL
      OR (
        length(native_cwd_path) BETWEEN 1 AND 4096
        AND instr(native_cwd_path, char(0)) = 0
        AND instr(native_cwd_path, char(10)) = 0
        AND instr(native_cwd_path, char(13)) = 0
      )
    ),
  wsl_distribution_name TEXT
    CHECK (
      wsl_distribution_name IS NULL
      OR (
        length(wsl_distribution_name) BETWEEN 1 AND 256
        AND wsl_distribution_name = trim(wsl_distribution_name)
        AND substr(wsl_distribution_name, 1, 1) <> '-'
        AND instr(wsl_distribution_name, char(0)) = 0
        AND instr(wsl_distribution_name, char(10)) = 0
        AND instr(wsl_distribution_name, char(13)) = 0
      )
    ),
  revision INTEGER NOT NULL DEFAULT 1
    CHECK (revision BETWEEN 1 AND 9007199254740991),
  updated_at TEXT NOT NULL,
  CHECK (
    (native_cwd_platform IS NULL AND native_cwd_path IS NULL)
    OR (native_cwd_platform IS NOT NULL AND native_cwd_path IS NOT NULL)
  )
) STRICT;

INSERT INTO workspace_terminal_preferences (
  workspace_id,
  preferred_profile_id,
  native_cwd_platform,
  native_cwd_path,
  wsl_distribution_name,
  revision,
  updated_at
)
SELECT
  id,
  'system-default',
  NULL,
  NULL,
  NULL,
  1,
  updated_at
FROM workspaces;

CREATE TRIGGER workspace_terminal_preferences_create_after_workspace
AFTER INSERT ON workspaces
BEGIN
  INSERT INTO workspace_terminal_preferences (
    workspace_id,
    preferred_profile_id,
    native_cwd_platform,
    native_cwd_path,
    wsl_distribution_name,
    revision,
    updated_at
  ) VALUES (
    NEW.id,
    'system-default',
    NULL,
    NULL,
    NULL,
    1,
    NEW.updated_at
  );
END;

CREATE TRIGGER workspace_terminal_preferences_workspace_is_immutable
BEFORE UPDATE OF workspace_id ON workspace_terminal_preferences
WHEN NEW.workspace_id <> OLD.workspace_id
BEGIN
  SELECT RAISE(ABORT, 'terminal preference workspace is immutable');
END;

CREATE TRIGGER workspace_terminal_preferences_revision_must_advance
BEFORE UPDATE ON workspace_terminal_preferences
WHEN NEW.revision <> OLD.revision + 1
BEGIN
  SELECT RAISE(ABORT, 'terminal preference revision must advance exactly once');
END;

CREATE TRIGGER workspace_terminal_preferences_updated_at_must_not_rewind
BEFORE UPDATE OF updated_at ON workspace_terminal_preferences
WHEN NEW.updated_at < OLD.updated_at
BEGIN
  SELECT RAISE(ABORT, 'terminal preference update time cannot move backwards');
END;

CREATE TRIGGER workspace_terminal_preferences_prevent_archived_workspace_mutation
BEFORE UPDATE ON workspace_terminal_preferences
WHEN EXISTS (
  SELECT 1 FROM workspaces
  WHERE id = OLD.workspace_id AND archived_at IS NOT NULL
)
BEGIN
  SELECT RAISE(ABORT, 'archived workspace terminal preferences are immutable');
END;

CREATE TRIGGER workspace_terminal_preferences_prevent_delete
BEFORE DELETE ON workspace_terminal_preferences
BEGIN
  SELECT RAISE(ABORT, 'terminal preferences cannot be deleted');
END;
