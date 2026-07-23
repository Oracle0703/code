CREATE TABLE backup_policy (
  singleton INTEGER PRIMARY KEY NOT NULL DEFAULT 1 CHECK (singleton = 1),
  enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0, 1)),
  cadence TEXT NOT NULL DEFAULT 'daily' CHECK (cadence IN ('daily', 'weekly')),
  local_time_minute INTEGER NOT NULL DEFAULT 120
    CHECK (local_time_minute BETWEEN 0 AND 1439),
  weekday INTEGER CHECK (weekday BETWEEN 0 AND 6),
  retention_count INTEGER NOT NULL DEFAULT 14
    CHECK (retention_count BETWEEN 1 AND 90),
  revision INTEGER NOT NULL DEFAULT 1
    CHECK (revision BETWEEN 1 AND 9007199254740991),
  updated_at TEXT NOT NULL,
  CHECK (
    (cadence = 'daily' AND weekday IS NULL)
    OR (cadence = 'weekly' AND weekday IS NOT NULL)
  )
) STRICT;

CREATE TRIGGER backup_policy_revision_must_advance
BEFORE UPDATE ON backup_policy
WHEN NEW.revision <> OLD.revision + 1
BEGIN
  SELECT RAISE(ABORT, 'backup policy revision must advance exactly once');
END;

CREATE TABLE backup_run_state (
  singleton INTEGER PRIMARY KEY NOT NULL DEFAULT 1 CHECK (singleton = 1),
  last_attempt_at TEXT,
  last_success_at TEXT,
  last_success_bucket TEXT,
  last_error_code TEXT
    CHECK (
      last_error_code IS NULL
      OR last_error_code IN ('backup-failed', 'retention-failed', 'database-unavailable')
    ),
  consecutive_failures INTEGER NOT NULL DEFAULT 0
    CHECK (consecutive_failures BETWEEN 0 AND 9007199254740991),
  updated_at TEXT NOT NULL,
  CHECK (last_success_at IS NULL OR last_attempt_at IS NOT NULL),
  CHECK (last_success_bucket IS NULL OR last_success_at IS NOT NULL)
) STRICT;

CREATE VIRTUAL TABLE inbox_entries_search USING fts5(
  content,
  content = 'inbox_entries',
  content_rowid = 'rowid',
  tokenize = 'trigram'
);

CREATE TRIGGER inbox_entries_search_insert
AFTER INSERT ON inbox_entries
BEGIN
  INSERT INTO inbox_entries_search(rowid, content)
  VALUES (NEW.rowid, NEW.content);
END;

CREATE TRIGGER inbox_entries_search_delete
AFTER DELETE ON inbox_entries
BEGIN
  INSERT INTO inbox_entries_search(inbox_entries_search, rowid, content)
  VALUES ('delete', OLD.rowid, OLD.content);
END;

CREATE TRIGGER inbox_entries_search_update
AFTER UPDATE OF content ON inbox_entries
BEGIN
  INSERT INTO inbox_entries_search(inbox_entries_search, rowid, content)
  VALUES ('delete', OLD.rowid, OLD.content);
  INSERT INTO inbox_entries_search(rowid, content)
  VALUES (NEW.rowid, NEW.content);
END;

INSERT INTO inbox_entries_search(inbox_entries_search) VALUES ('rebuild');

CREATE VIRTUAL TABLE tasks_search USING fts5(
  title,
  content = 'tasks',
  content_rowid = 'rowid',
  tokenize = 'trigram'
);

CREATE TRIGGER tasks_search_insert
AFTER INSERT ON tasks
BEGIN
  INSERT INTO tasks_search(rowid, title)
  VALUES (NEW.rowid, NEW.title);
END;

CREATE TRIGGER tasks_search_delete
AFTER DELETE ON tasks
BEGIN
  INSERT INTO tasks_search(tasks_search, rowid, title)
  VALUES ('delete', OLD.rowid, OLD.title);
END;

CREATE TRIGGER tasks_search_update
AFTER UPDATE OF title ON tasks
BEGIN
  INSERT INTO tasks_search(tasks_search, rowid, title)
  VALUES ('delete', OLD.rowid, OLD.title);
  INSERT INTO tasks_search(rowid, title)
  VALUES (NEW.rowid, NEW.title);
END;

INSERT INTO tasks_search(tasks_search) VALUES ('rebuild');

CREATE VIRTUAL TABLE notes_search USING fts5(
  title,
  body,
  content = 'notes',
  content_rowid = 'rowid',
  tokenize = 'trigram'
);

CREATE TRIGGER notes_search_insert
AFTER INSERT ON notes
BEGIN
  INSERT INTO notes_search(rowid, title, body)
  VALUES (NEW.rowid, NEW.title, NEW.body);
END;

CREATE TRIGGER notes_search_delete
AFTER DELETE ON notes
BEGIN
  INSERT INTO notes_search(notes_search, rowid, title, body)
  VALUES ('delete', OLD.rowid, OLD.title, OLD.body);
END;

CREATE TRIGGER notes_search_update
AFTER UPDATE OF title, body ON notes
BEGIN
  INSERT INTO notes_search(notes_search, rowid, title, body)
  VALUES ('delete', OLD.rowid, OLD.title, OLD.body);
  INSERT INTO notes_search(rowid, title, body)
  VALUES (NEW.rowid, NEW.title, NEW.body);
END;

INSERT INTO notes_search(notes_search) VALUES ('rebuild');

CREATE VIRTUAL TABLE schedule_items_search USING fts5(
  title,
  content = 'schedule_items',
  content_rowid = 'rowid',
  tokenize = 'trigram'
);

CREATE TRIGGER schedule_items_search_insert
AFTER INSERT ON schedule_items
BEGIN
  INSERT INTO schedule_items_search(rowid, title)
  VALUES (NEW.rowid, NEW.title);
END;

CREATE TRIGGER schedule_items_search_delete
AFTER DELETE ON schedule_items
BEGIN
  INSERT INTO schedule_items_search(schedule_items_search, rowid, title)
  VALUES ('delete', OLD.rowid, OLD.title);
END;

CREATE TRIGGER schedule_items_search_update
AFTER UPDATE OF title ON schedule_items
BEGIN
  INSERT INTO schedule_items_search(schedule_items_search, rowid, title)
  VALUES ('delete', OLD.rowid, OLD.title);
  INSERT INTO schedule_items_search(rowid, title)
  VALUES (NEW.rowid, NEW.title);
END;

INSERT INTO schedule_items_search(schedule_items_search) VALUES ('rebuild');

CREATE VIRTUAL TABLE browser_tabs_search USING fts5(
  title,
  url,
  content = 'browser_tabs',
  content_rowid = 'rowid',
  tokenize = 'trigram'
);

CREATE TRIGGER browser_tabs_search_insert
AFTER INSERT ON browser_tabs
BEGIN
  INSERT INTO browser_tabs_search(rowid, title, url)
  VALUES (NEW.rowid, NEW.title, NEW.url);
END;

CREATE TRIGGER browser_tabs_search_delete
AFTER DELETE ON browser_tabs
BEGIN
  INSERT INTO browser_tabs_search(browser_tabs_search, rowid, title, url)
  VALUES ('delete', OLD.rowid, OLD.title, OLD.url);
END;

CREATE TRIGGER browser_tabs_search_update
AFTER UPDATE OF title, url ON browser_tabs
BEGIN
  INSERT INTO browser_tabs_search(browser_tabs_search, rowid, title, url)
  VALUES ('delete', OLD.rowid, OLD.title, OLD.url);
  INSERT INTO browser_tabs_search(rowid, title, url)
  VALUES (NEW.rowid, NEW.title, NEW.url);
END;

INSERT INTO browser_tabs_search(browser_tabs_search) VALUES ('rebuild');

CREATE VIRTUAL TABLE browser_bookmarks_search USING fts5(
  title,
  url,
  content = 'browser_bookmarks',
  content_rowid = 'rowid',
  tokenize = 'trigram'
);

CREATE TRIGGER browser_bookmarks_search_insert
AFTER INSERT ON browser_bookmarks
BEGIN
  INSERT INTO browser_bookmarks_search(rowid, title, url)
  VALUES (NEW.rowid, NEW.title, NEW.url);
END;

CREATE TRIGGER browser_bookmarks_search_delete
AFTER DELETE ON browser_bookmarks
BEGIN
  INSERT INTO browser_bookmarks_search(browser_bookmarks_search, rowid, title, url)
  VALUES ('delete', OLD.rowid, OLD.title, OLD.url);
END;

INSERT INTO browser_bookmarks_search(browser_bookmarks_search) VALUES ('rebuild');
