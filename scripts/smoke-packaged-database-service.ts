import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { WORKSPACE_COLORS } from '../src/shared/contracts';
import { DatabaseService } from '../src/main/database';
import { DEFAULT_MIGRATIONS } from '../src/main/database/default-migrations';
import { MetadataRepository } from '../src/main/database/metadata-repository';
import { MigrationRunner } from '../src/main/database/migration-runner';
import {
  configureDesktopPragmas,
  createNodeSqliteAdapter,
} from '../src/main/database/sqlite-adapter';
import { InboxService } from '../src/main/inbox';
import { NoteService } from '../src/main/notes';
import { ScheduleService } from '../src/main/schedule';
import { TaskService } from '../src/main/tasks';
import { WorkspaceService } from '../src/main/workspaces';

const DEFAULT_WORKSPACE_ID = '11111111-1111-4111-8111-111111111111';
const SECOND_WORKSPACE_ID = '22222222-2222-4222-8222-222222222222';
const FIRST_INBOX_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const SECOND_INBOX_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const NOTE_INBOX_ID = '12121212-1212-4212-8212-121212121212';
const FIRST_UNDO_TOKEN = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const SECOND_UNDO_TOKEN = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const FIRST_TASK_ID = '44444444-4444-4444-8444-444444444444';
const SECOND_TASK_ID = '55555555-5555-4555-8555-555555555555';
const THIRD_TASK_ID = '66666666-6666-4666-8666-666666666666';
const CONVERTED_TASK_ID = '77777777-7777-4777-8777-777777777777';
const LEGACY_CONVERTED_TASK_ID = '88888888-8888-4888-8888-888888888888';
const FIRST_NOTE_ID = '13131313-1313-4313-8313-131313131313';
const SECOND_NOTE_ID = '14141414-1414-4414-8414-141414141414';
const CONVERTED_NOTE_ID = '15151515-1515-4515-8515-151515151515';
const FIRST_SCHEDULE_ID = '16161616-1616-4616-8616-161616161616';
const SECOND_SCHEDULE_ID = '17171717-1717-4717-8717-171717171717';
const THIRD_SCHEDULE_ID = '18181818-1818-4818-8818-181818181818';
const FIRST_BROWSER_TAB_ID = '21212121-2121-4121-8121-212121212121';
const SECOND_BROWSER_TAB_ID = '23232323-2323-4323-8323-232323232323';
const THIRD_BROWSER_TAB_ID = '24242424-2424-4424-8424-242424242424';
const FOURTH_BROWSER_TAB_ID = '25252525-2525-4525-8525-252525252525';
const FIRST_BROWSER_BOOKMARK_ID = '26262626-2626-4626-8626-262626262626';
const FIXED_NOW = new Date('2026-07-22T12:34:56.000Z');
const FIXED_TODAY = '2026-07-22';

async function main(): Promise<void> {
  assert.ok(
    process.versions.electron,
    'Run this bundle with the packaged Electron executable and ELECTRON_RUN_AS_NODE=1.',
  );

  const root = await mkdtemp(join(tmpdir(), 'daily workbench 服务 smoke-'));
  try {
    await smokeCurrentService(join(root, 'current 数据'));
    await smokeVersionOneUpgrade(join(root, 'legacy v1 数据'));
    await smokeVersionTwoUpgrade(join(root, 'legacy v2 数据'));
    await smokeVersionThreeUpgrade(join(root, 'legacy v3 数据'));
    await smokeVersionFourUpgrade(join(root, 'legacy v4 数据'));
    await smokeVersionFiveUpgrade(join(root, 'legacy v5 数据'));
    console.log(
      `Packaged DatabaseService workspace/inbox/task/note/schedule/browser/migration/backup/reopen smoke test passed ` +
        `(Electron ${process.versions.electron}, Node ${process.versions.node}, ` +
        `SQLite ${process.versions.sqlite}).`,
    );
  } finally {
    await removeSmokeDirectory(root);
  }
}

async function smokeCurrentService(dataDirectory: string): Promise<void> {
  const ids = [DEFAULT_WORKSPACE_ID, SECOND_WORKSPACE_ID];
  const inboxIds = [FIRST_INBOX_ID, SECOND_INBOX_ID, NOTE_INBOX_ID];
  const undoTokens = [FIRST_UNDO_TOKEN, SECOND_UNDO_TOKEN];
  const taskIds = [FIRST_TASK_ID, SECOND_TASK_ID, THIRD_TASK_ID, CONVERTED_TASK_ID];
  const noteIds = [FIRST_NOTE_ID, SECOND_NOTE_ID, CONVERTED_NOTE_ID];
  const scheduleIds = [FIRST_SCHEDULE_ID, SECOND_SCHEDULE_ID, THIRD_SCHEDULE_ID];
  const browserTabIds = [FIRST_BROWSER_TAB_ID, SECOND_BROWSER_TAB_ID, THIRD_BROWSER_TAB_ID];
  const browserBookmarkIds = [FIRST_BROWSER_BOOKMARK_ID];
  let service: DatabaseService | undefined = new DatabaseService({
    dataDirectory,
    now: () => FIXED_NOW,
    workspaceIdFactory: () => ids.shift() ?? '33333333-3333-4333-8333-333333333333',
    inboxIdFactory: () => inboxIds.shift() ?? 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
    inboxUndoTokenFactory: () => undoTokens.shift() ?? 'ffffffff-ffff-4fff-8fff-ffffffffffff',
    taskIdFactory: () => taskIds.shift() ?? '99999999-9999-4999-8999-999999999999',
    taskTodayFactory: () => FIXED_TODAY,
    noteIdFactory: () => noteIds.shift() ?? '19191919-1919-4919-8919-191919191919',
    scheduleIdFactory: () => scheduleIds.shift() ?? '20202020-2020-4020-8020-202020202020',
    scheduleTodayFactory: () => FIXED_TODAY,
    browserTabIdFactory: () => browserTabIds.shift() ?? '27272727-2727-4727-8727-272727272727',
    browserBookmarkIdFactory: () =>
      browserBookmarkIds.shift() ?? '28282828-2828-4828-8828-282828282828',
  });

  try {
    const initialized = await service.open();
    assert.equal(initialized.migration.fromVersion, 0);
    assert.equal(initialized.migration.toVersion, 6);
    assert.equal(initialized.preMigrationBackup, undefined);

    const status = await service.getStatus();
    assert.deepEqual(
      {
        schemaVersion: status.schemaVersion,
        appliedMigrations: status.appliedMigrations,
        journalMode: status.journalMode,
        integrityCheck: status.integrityCheck,
        backupCount: status.backupCount,
      },
      {
        schemaVersion: 6,
        appliedMigrations: 6,
        journalMode: 'wal',
        integrityCheck: 'ok',
        backupCount: 0,
      },
    );
    assert.equal(status.sqliteVersion, process.versions.sqlite);
    assert.equal('databasePath' in status, false);

    let snapshot = await service.getWorkspaceSnapshot();
    assert.equal(snapshot.currentWorkspaceId, DEFAULT_WORKSPACE_ID);
    assert.equal(snapshot.workspaces.length, 1);
    assert.equal(snapshot.workspaces[0]?.name, '我的工作台');
    let inbox = await service.getInboxSnapshot({ workspaceId: DEFAULT_WORKSPACE_ID });
    assert.deepEqual(inbox.entries, []);
    inbox = await service.createInboxEntry({
      workspaceId: DEFAULT_WORKSPACE_ID,
      content: '  打包后的 ＡPI / e\u0301 / 👩‍💻  ',
      category: 'uncategorized',
    });
    assert.equal(inbox.entries[0]?.id, FIRST_INBOX_ID);
    assert.equal(inbox.entries[0]?.content, '打包后的 ＡPI / e\u0301 / 👩‍💻');
    inbox = await service.categorizeInboxEntry({
      workspaceId: DEFAULT_WORKSPACE_ID,
      entryId: FIRST_INBOX_ID,
      category: 'task',
    });
    assert.equal(inbox.entries[0]?.category, 'task');
    await service.updateWorkspacePreferences({
      workspaceId: DEFAULT_WORKSPACE_ID,
      patch: { theme: 'light', activeView: 'notes', browserWidth: 518 },
    });

    let browser = await service.getBrowserData({ workspaceId: DEFAULT_WORKSPACE_ID });
    assert.equal(browser.revision, 1);
    assert.equal(browser.activeTabId, FIRST_BROWSER_TAB_ID);
    assert.equal(browser.tabs[0]?.url, 'https://www.google.com/');
    browser = await service.persistBrowserTabMetadata({
      workspaceId: DEFAULT_WORKSPACE_ID,
      tabId: FIRST_BROWSER_TAB_ID,
      url: 'https://example.com/packaged',
      title: '  打包后的浏览器\n标题  ',
    });
    assert.equal(browser.revision, 2);
    assert.equal(browser.tabs[0]?.title, '打包后的浏览器 标题');
    browser = await service.toggleBrowserBookmark({
      workspaceId: DEFAULT_WORKSPACE_ID,
      tabId: FIRST_BROWSER_TAB_ID,
    });
    assert.equal(browser.bookmarks[0]?.id, FIRST_BROWSER_BOOKMARK_ID);
    assert.equal(browser.bookmarks[0]?.url, 'https://example.com/packaged');
    browser = await service.createBrowserTab({
      workspaceId: DEFAULT_WORKSPACE_ID,
      url: 'about:blank',
    });
    assert.equal(browser.activeTabId, SECOND_BROWSER_TAB_ID);
    browser = await service.closeBrowserTab({
      workspaceId: DEFAULT_WORKSPACE_ID,
      tabId: SECOND_BROWSER_TAB_ID,
    });
    assert.equal(browser.activeTabId, FIRST_BROWSER_TAB_ID);
    assert.equal(browser.tabs.length, 1);

    let tasks = await service.getTaskSnapshot({ workspaceId: DEFAULT_WORKSPACE_ID });
    assert.equal(tasks.todayDate, FIXED_TODAY);
    assert.deepEqual(tasks.tasks, []);
    tasks = await service.createTask({
      workspaceId: DEFAULT_WORKSPACE_ID,
      title: '  打包后的任务 / e\u0301 / 👩‍💻  ',
      planning: 'today',
    });
    let task = tasks.tasks.find(({ id }) => id === FIRST_TASK_ID);
    assert.ok(task);
    assert.equal(task.title, '打包后的任务 / e\u0301 / 👩‍💻');
    assert.equal(task.status, 'todo');
    assert.equal(task.plannedFor, FIXED_TODAY);
    assert.equal(task.sourceInboxEntryId, null);
    assert.equal(task.completedAt, null);

    tasks = await service.createTask({
      workspaceId: DEFAULT_WORKSPACE_ID,
      title: '稍后处理的任务',
      planning: 'none',
    });
    task = tasks.tasks.find(({ id }) => id === SECOND_TASK_ID);
    assert.ok(task);
    assert.equal(task.plannedFor, null);
    tasks = await service.renameTask({
      workspaceId: DEFAULT_WORKSPACE_ID,
      taskId: FIRST_TASK_ID,
      title: '已重命名的打包任务',
    });
    tasks = await service.updateTaskStatus({
      workspaceId: DEFAULT_WORKSPACE_ID,
      taskId: FIRST_TASK_ID,
      status: 'in_progress',
    });
    tasks = await service.updateTaskStatus({
      workspaceId: DEFAULT_WORKSPACE_ID,
      taskId: FIRST_TASK_ID,
      status: 'completed',
    });
    task = tasks.tasks.find(({ id }) => id === FIRST_TASK_ID);
    assert.ok(task);
    assert.equal(task.title, '已重命名的打包任务');
    assert.equal(task.status, 'completed');
    assert.equal(task.completedAt, FIXED_NOW.toISOString());
    tasks = await service.updateTaskPlanning({
      workspaceId: DEFAULT_WORKSPACE_ID,
      taskId: SECOND_TASK_ID,
      planning: 'today',
    });
    assert.equal(tasks.tasks.find(({ id }) => id === SECOND_TASK_ID)?.plannedFor, FIXED_TODAY);
    tasks = await service.updateTaskPlanning({
      workspaceId: DEFAULT_WORKSPACE_ID,
      taskId: SECOND_TASK_ID,
      planning: 'none',
    });
    assert.equal(tasks.tasks.find(({ id }) => id === SECOND_TASK_ID)?.plannedFor, null);

    let notes = await service.getNoteSnapshot({ workspaceId: DEFAULT_WORKSPACE_ID });
    assert.deepEqual(notes.notes, []);
    notes = await service.createNote({
      workspaceId: DEFAULT_WORKSPACE_ID,
      title: '  打包后的 Markdown 笔记 👩‍💻  ',
      body: '# 产物验证\r\n\r\n- e\u0301\r\n- 👩‍💻',
    });
    let note = notes.notes.find(({ id }) => id === FIRST_NOTE_ID);
    assert.ok(note);
    assert.equal(note.title, '打包后的 Markdown 笔记 👩‍💻');
    assert.equal(note.body, '# 产物验证\n\n- e\u0301\n- 👩‍💻');
    assert.equal(note.revision, 1);
    assert.equal(note.sourceInboxEntryId, null);
    notes = await service.updateNote({
      workspaceId: DEFAULT_WORKSPACE_ID,
      noteId: FIRST_NOTE_ID,
      title: '已更新的 Markdown 笔记',
      body: '```ts\nconst packaged = true;\n```',
      expectedRevision: 1,
    });
    note = notes.notes.find(({ id }) => id === FIRST_NOTE_ID);
    assert.ok(note);
    assert.equal(note.revision, 2);
    await assert.rejects(
      service.updateNote({
        workspaceId: DEFAULT_WORKSPACE_ID,
        noteId: FIRST_NOTE_ID,
        title: '迟到的旧写入',
        body: '不应覆盖 revision 2',
        expectedRevision: 1,
      }),
    );
    notes = await service.archiveNote({
      workspaceId: DEFAULT_WORKSPACE_ID,
      noteId: FIRST_NOTE_ID,
      expectedRevision: 2,
    });
    assert.deepEqual(notes.notes, []);

    let schedule = await service.getScheduleSnapshot({ workspaceId: DEFAULT_WORKSPACE_ID });
    assert.equal(schedule.todayDate, FIXED_TODAY);
    assert.deepEqual(schedule.items, []);
    schedule = await service.createScheduleItem({
      workspaceId: DEFAULT_WORKSPACE_ID,
      expectedDate: FIXED_TODAY,
      title: '打包后的晨会',
      kind: 'meeting',
      startMinute: 9 * 60,
      endMinute: 10 * 60,
    });
    let scheduleItem = schedule.items.find(({ id }) => id === FIRST_SCHEDULE_ID);
    assert.ok(scheduleItem);
    assert.equal(scheduleItem.scheduledFor, FIXED_TODAY);
    assert.equal(scheduleItem.revision, 1);
    schedule = await service.updateScheduleItem({
      workspaceId: DEFAULT_WORKSPACE_ID,
      scheduleId: FIRST_SCHEDULE_ID,
      expectedDate: FIXED_TODAY,
      expectedRevision: 1,
      title: '打包后的专注时间',
      kind: 'focus',
      startMinute: 9 * 60 + 5,
      endMinute: 10 * 60 + 15,
    });
    scheduleItem = schedule.items.find(({ id }) => id === FIRST_SCHEDULE_ID);
    assert.ok(scheduleItem);
    assert.equal(scheduleItem.revision, 2);
    assert.equal(scheduleItem.kind, 'focus');
    await assert.rejects(
      service.updateScheduleItem({
        workspaceId: DEFAULT_WORKSPACE_ID,
        scheduleId: FIRST_SCHEDULE_ID,
        expectedDate: FIXED_TODAY,
        expectedRevision: 1,
        title: '迟到的旧日程',
        kind: 'review',
        startMinute: 11 * 60,
        endMinute: 12 * 60,
      }),
    );
    schedule = await service.createScheduleItem({
      workspaceId: DEFAULT_WORKSPACE_ID,
      expectedDate: FIXED_TODAY,
      title: '待归档的个人安排',
      kind: 'personal',
      startMinute: 18 * 60,
      endMinute: 19 * 60,
    });
    assert.equal(
      schedule.items.some(({ id }) => id === SECOND_SCHEDULE_ID),
      true,
    );
    schedule = await service.archiveScheduleItem({
      workspaceId: DEFAULT_WORKSPACE_ID,
      scheduleId: SECOND_SCHEDULE_ID,
      expectedDate: FIXED_TODAY,
      expectedRevision: 1,
    });
    assert.deepEqual(
      schedule.items.map(({ id }) => id),
      [FIRST_SCHEDULE_ID],
    );

    snapshot = await service.createWorkspace({
      name: '开发 与 探索 🧪',
      color: WORKSPACE_COLORS[2],
    });
    assert.equal(snapshot.currentWorkspaceId, SECOND_WORKSPACE_ID);
    browser = await service.getBrowserData({ workspaceId: SECOND_WORKSPACE_ID });
    assert.equal(browser.activeTabId, THIRD_BROWSER_TAB_ID);
    assert.equal(browser.tabs.length, 1);
    assert.deepEqual(browser.bookmarks, []);
    inbox = await service.createInboxEntry({
      workspaceId: SECOND_WORKSPACE_ID,
      content: 'https://example.com/工作区隔离',
      category: 'link',
    });
    assert.equal(inbox.entries[0]?.id, SECOND_INBOX_ID);
    tasks = await service.createTask({
      workspaceId: SECOND_WORKSPACE_ID,
      title: '第二工作区任务',
      planning: 'none',
    });
    assert.equal(tasks.workspaceId, SECOND_WORKSPACE_ID);
    assert.equal(tasks.tasks[0]?.id, THIRD_TASK_ID);
    tasks = await service.updateTaskStatus({
      workspaceId: SECOND_WORKSPACE_ID,
      taskId: THIRD_TASK_ID,
      status: 'in_progress',
    });
    assert.equal(tasks.tasks[0]?.status, 'in_progress');
    notes = await service.createNote({
      workspaceId: SECOND_WORKSPACE_ID,
      title: '第二工作区笔记',
      body: '只属于研发工作区。',
    });
    assert.equal(notes.notes[0]?.id, SECOND_NOTE_ID);
    schedule = await service.createScheduleItem({
      workspaceId: SECOND_WORKSPACE_ID,
      expectedDate: FIXED_TODAY,
      title: '第二工作区回顾',
      kind: 'review',
      startMinute: 16 * 60,
      endMinute: 16 * 60 + 30,
    });
    assert.equal(schedule.items[0]?.id, THIRD_SCHEDULE_ID);
    assert.equal(
      (await service.getInboxSnapshot({ workspaceId: DEFAULT_WORKSPACE_ID })).entries.length,
      1,
    );
    assert.deepEqual(
      (await service.getTaskSnapshot({ workspaceId: DEFAULT_WORKSPACE_ID })).tasks
        .map(({ id }) => id)
        .sort(),
      [FIRST_TASK_ID, SECOND_TASK_ID],
    );
    assert.deepEqual(
      (await service.getNoteSnapshot({ workspaceId: DEFAULT_WORKSPACE_ID })).notes,
      [],
    );
    assert.deepEqual(
      (await service.getScheduleSnapshot({ workspaceId: DEFAULT_WORKSPACE_ID })).items.map(
        ({ id }) => id,
      ),
      [FIRST_SCHEDULE_ID],
    );
    let archivedInbox = await service.archiveInboxEntry({
      workspaceId: SECOND_WORKSPACE_ID,
      entryId: SECOND_INBOX_ID,
    });
    assert.equal(archivedInbox.undoToken, FIRST_UNDO_TOKEN);
    assert.equal(archivedInbox.snapshot.entries.length, 0);
    inbox = await service.undoInboxArchive({
      workspaceId: SECOND_WORKSPACE_ID,
      undoToken: archivedInbox.undoToken,
    });
    assert.equal(inbox.entries[0]?.id, SECOND_INBOX_ID);
    archivedInbox = await service.archiveInboxEntry({
      workspaceId: SECOND_WORKSPACE_ID,
      entryId: SECOND_INBOX_ID,
    });
    assert.equal(archivedInbox.undoToken, SECOND_UNDO_TOKEN);
    await service.renameWorkspace({ workspaceId: SECOND_WORKSPACE_ID, name: '研发工作区 🧪' });
    await service.updateWorkspacePreferences({
      workspaceId: SECOND_WORKSPACE_ID,
      patch: { activeView: 'tasks', browserOpen: false, terminalHeight: 472 },
    });

    snapshot = await service.activateWorkspace({ workspaceId: DEFAULT_WORKSPACE_ID });
    assert.deepEqual(
      {
        theme: snapshot.preferences.theme,
        activeView: snapshot.preferences.activeView,
        browserWidth: snapshot.preferences.browserWidth,
      },
      { theme: 'light', activeView: 'notes', browserWidth: 518 },
    );
    inbox = await service.createInboxEntry({
      workspaceId: DEFAULT_WORKSPACE_ID,
      content: '来自收件箱的 Markdown 笔记 👩‍💻',
      category: 'note',
    });
    assert.equal(
      inbox.entries.some(({ id }) => id === NOTE_INBOX_ID),
      true,
    );
    const conversion = await service.convertInboxToTask({
      workspaceId: DEFAULT_WORKSPACE_ID,
      entryId: FIRST_INBOX_ID,
      planning: 'today',
    });
    assert.equal(conversion.inboxSnapshot.workspaceId, DEFAULT_WORKSPACE_ID);
    assert.deepEqual(
      conversion.inboxSnapshot.entries.map(({ id }) => id),
      [NOTE_INBOX_ID],
    );
    task = conversion.taskSnapshot.tasks.find(({ id }) => id === CONVERTED_TASK_ID);
    assert.ok(task);
    assert.equal(task.title, '打包后的 ＡPI / e\u0301 / 👩‍💻');
    assert.equal(task.sourceInboxEntryId, FIRST_INBOX_ID);
    assert.equal(task.plannedFor, FIXED_TODAY);
    const taskCountAfterConversion = conversion.taskSnapshot.tasks.length;
    await assert.rejects(
      service.convertInboxToTask({
        workspaceId: DEFAULT_WORKSPACE_ID,
        entryId: FIRST_INBOX_ID,
        planning: 'none',
      }),
    );
    assert.equal(
      (await service.getTaskSnapshot({ workspaceId: DEFAULT_WORKSPACE_ID })).tasks.length,
      taskCountAfterConversion,
    );
    const noteConversion = await service.convertInboxToNote({
      workspaceId: DEFAULT_WORKSPACE_ID,
      entryId: NOTE_INBOX_ID,
    });
    assert.deepEqual(noteConversion.inboxSnapshot.entries, []);
    note = noteConversion.noteSnapshot.notes.find(({ id }) => id === CONVERTED_NOTE_ID);
    assert.ok(note);
    assert.equal(note.title, '来自收件箱的 Markdown 笔记 👩‍💻');
    assert.equal(note.body, '来自收件箱的 Markdown 笔记 👩‍💻');
    assert.equal(note.sourceInboxEntryId, NOTE_INBOX_ID);
    assert.equal(note.revision, 1);
    await assert.rejects(
      service.convertInboxToNote({
        workspaceId: DEFAULT_WORKSPACE_ID,
        entryId: FIRST_INBOX_ID,
      }),
    );
    await assert.rejects(
      service.convertInboxToTask({
        workspaceId: DEFAULT_WORKSPACE_ID,
        entryId: NOTE_INBOX_ID,
        planning: 'none',
      }),
    );
    assert.deepEqual(
      (await service.getInboxSnapshot({ workspaceId: DEFAULT_WORKSPACE_ID })).entries,
      [],
    );
    snapshot = await service.activateWorkspace({ workspaceId: SECOND_WORKSPACE_ID });
    assert.deepEqual(
      {
        activeView: snapshot.preferences.activeView,
        browserOpen: snapshot.preferences.browserOpen,
        terminalHeight: snapshot.preferences.terminalHeight,
      },
      { activeView: 'tasks', browserOpen: false, terminalHeight: 472 },
    );

    snapshot = await service.archiveWorkspace({ workspaceId: SECOND_WORKSPACE_ID });
    assert.equal(snapshot.currentWorkspaceId, DEFAULT_WORKSPACE_ID);
    assert.deepEqual(
      snapshot.workspaces.map(({ id }) => id),
      [DEFAULT_WORKSPACE_ID],
    );
    await assert.rejects(service.getBrowserData({ workspaceId: SECOND_WORKSPACE_ID }));

    const created = await service.createBackup();
    assert.equal(created.reason, 'manual');
    assert.equal(created.schemaVersion, 6);
    assert.equal('path' in created, false);
    assert.deepEqual(await service.listBackups(), [created]);
    await service.close();
    service = undefined;

    const backupPath = join(dataDirectory, 'backups', created.fileName);
    const backup = new DatabaseSync(backupPath, { readOnly: true });
    try {
      assert.equal(backup.prepare('PRAGMA user_version').get()?.user_version, 6);
      assert.equal(backup.prepare('PRAGMA quick_check').get()?.quick_check, 'ok');
      assert.equal(backup.prepare('SELECT COUNT(*) AS count FROM workspaces').get()?.count, 2);
      assert.equal(
        backup.prepare('SELECT current_workspace_id FROM workspace_app_state').get()
          ?.current_workspace_id,
        DEFAULT_WORKSPACE_ID,
      );
      assert.equal(
        backup.prepare('SELECT archived_at FROM workspaces WHERE id = ?').get(SECOND_WORKSPACE_ID)
          ?.archived_at !== null,
        true,
      );
      assert.equal(backup.prepare('SELECT COUNT(*) AS count FROM inbox_entries').get()?.count, 3);
      const archivedInboxRow = backup
        .prepare(
          'SELECT category, archived_at IS NOT NULL AS archived FROM inbox_entries WHERE id = ?',
        )
        .get(SECOND_INBOX_ID);
      assert.equal(archivedInboxRow?.category, 'link');
      assert.equal(archivedInboxRow?.archived, 1);
      assert.equal(backup.prepare('SELECT COUNT(*) AS count FROM tasks').get()?.count, 4);
      const convertedTaskRow = backup
        .prepare(
          `SELECT title, status, planned_for, source_inbox_entry_id,
                  completed_at IS NOT NULL AS completed
           FROM tasks
           WHERE id = ?`,
        )
        .get(CONVERTED_TASK_ID);
      assert.equal(convertedTaskRow?.title, '打包后的 ＡPI / e\u0301 / 👩‍💻');
      assert.equal(convertedTaskRow?.status, 'todo');
      assert.equal(convertedTaskRow?.planned_for, FIXED_TODAY);
      assert.equal(convertedTaskRow?.source_inbox_entry_id, FIRST_INBOX_ID);
      assert.equal(convertedTaskRow?.completed, 0);
      const completedTaskRow = backup
        .prepare('SELECT status, completed_at, planned_for FROM tasks WHERE id = ?')
        .get(FIRST_TASK_ID);
      assert.equal(completedTaskRow?.status, 'completed');
      assert.equal(completedTaskRow?.completed_at, FIXED_NOW.toISOString());
      assert.equal(completedTaskRow?.planned_for, FIXED_TODAY);
      assert.equal(backup.prepare('SELECT COUNT(*) AS count FROM notes').get()?.count, 3);
      const archivedNoteRow = backup
        .prepare(
          `SELECT title, body, revision, source_inbox_entry_id,
                  archived_at IS NOT NULL AS archived
           FROM notes
           WHERE id = ?`,
        )
        .get(FIRST_NOTE_ID);
      assert.equal(archivedNoteRow?.title, '已更新的 Markdown 笔记');
      assert.equal(archivedNoteRow?.body, '```ts\nconst packaged = true;\n```');
      assert.equal(archivedNoteRow?.revision, 3);
      assert.equal(archivedNoteRow?.source_inbox_entry_id, null);
      assert.equal(archivedNoteRow?.archived, 1);
      const convertedNoteRow = backup
        .prepare(
          `SELECT title, body, revision, source_inbox_entry_id,
                  archived_at IS NULL AS active
           FROM notes
           WHERE id = ?`,
        )
        .get(CONVERTED_NOTE_ID);
      assert.equal(convertedNoteRow?.title, '来自收件箱的 Markdown 笔记 👩‍💻');
      assert.equal(convertedNoteRow?.body, '来自收件箱的 Markdown 笔记 👩‍💻');
      assert.equal(convertedNoteRow?.revision, 1);
      assert.equal(convertedNoteRow?.source_inbox_entry_id, NOTE_INBOX_ID);
      assert.equal(convertedNoteRow?.active, 1);
      const archivedWorkspaceNoteRow = backup
        .prepare('SELECT workspace_id, archived_at IS NULL AS active FROM notes WHERE id = ?')
        .get(SECOND_NOTE_ID);
      assert.equal(archivedWorkspaceNoteRow?.workspace_id, SECOND_WORKSPACE_ID);
      assert.equal(archivedWorkspaceNoteRow?.active, 1);
      assert.equal(backup.prepare('SELECT COUNT(*) AS count FROM schedule_items').get()?.count, 3);
      const activeScheduleRow = backup
        .prepare(
          `SELECT title, kind, scheduled_for, start_minute, end_minute, revision,
                  archived_at IS NULL AS active
           FROM schedule_items
           WHERE id = ?`,
        )
        .get(FIRST_SCHEDULE_ID);
      assert.equal(activeScheduleRow?.title, '打包后的专注时间');
      assert.equal(activeScheduleRow?.kind, 'focus');
      assert.equal(activeScheduleRow?.scheduled_for, FIXED_TODAY);
      assert.equal(activeScheduleRow?.start_minute, 9 * 60 + 5);
      assert.equal(activeScheduleRow?.end_minute, 10 * 60 + 15);
      assert.equal(activeScheduleRow?.revision, 2);
      assert.equal(activeScheduleRow?.active, 1);
      const archivedScheduleRow = backup
        .prepare(
          'SELECT revision, archived_at IS NOT NULL AS archived FROM schedule_items WHERE id = ?',
        )
        .get(SECOND_SCHEDULE_ID);
      assert.equal(archivedScheduleRow?.revision, 2);
      assert.equal(archivedScheduleRow?.archived, 1);
      const archivedWorkspaceScheduleRow = backup
        .prepare(
          'SELECT workspace_id, archived_at IS NULL AS active FROM schedule_items WHERE id = ?',
        )
        .get(THIRD_SCHEDULE_ID);
      assert.equal(archivedWorkspaceScheduleRow?.workspace_id, SECOND_WORKSPACE_ID);
      assert.equal(archivedWorkspaceScheduleRow?.active, 1);
      assert.equal(backup.prepare('SELECT COUNT(*) AS count FROM browser_tabs').get()?.count, 2);
      assert.equal(
        backup.prepare('SELECT COUNT(*) AS count FROM browser_workspace_state').get()?.count,
        2,
      );
      assert.equal(
        backup.prepare('SELECT COUNT(*) AS count FROM browser_bookmarks').get()?.count,
        1,
      );
    } finally {
      backup.close();
    }

    service = new DatabaseService({
      dataDirectory,
      taskTodayFactory: () => FIXED_TODAY,
      scheduleTodayFactory: () => FIXED_TODAY,
    });
    const reopened = await service.open();
    assert.equal(reopened.migration.fromVersion, 6);
    assert.equal(reopened.migration.toVersion, 6);
    assert.equal(reopened.migration.applied.length, 0);
    snapshot = await service.getWorkspaceSnapshot();
    assert.equal(snapshot.currentWorkspaceId, DEFAULT_WORKSPACE_ID);
    assert.equal(snapshot.workspaces.length, 1);
    assert.equal(snapshot.preferences.theme, 'light');
    inbox = await service.getInboxSnapshot({ workspaceId: DEFAULT_WORKSPACE_ID });
    assert.deepEqual(inbox.entries, []);
    tasks = await service.getTaskSnapshot({ workspaceId: DEFAULT_WORKSPACE_ID });
    assert.equal(tasks.todayDate, FIXED_TODAY);
    assert.equal(tasks.tasks.length, 3);
    assert.equal(tasks.tasks.find(({ id }) => id === FIRST_TASK_ID)?.status, 'completed');
    assert.equal(
      tasks.tasks.find(({ id }) => id === CONVERTED_TASK_ID)?.sourceInboxEntryId,
      FIRST_INBOX_ID,
    );
    assert.equal(tasks.tasks.find(({ id }) => id === SECOND_TASK_ID)?.plannedFor, null);
    notes = await service.getNoteSnapshot({ workspaceId: DEFAULT_WORKSPACE_ID });
    assert.deepEqual(
      notes.notes.map(({ id }) => id),
      [CONVERTED_NOTE_ID],
    );
    assert.equal(notes.notes[0]?.sourceInboxEntryId, NOTE_INBOX_ID);
    schedule = await service.getScheduleSnapshot({ workspaceId: DEFAULT_WORKSPACE_ID });
    assert.equal(schedule.todayDate, FIXED_TODAY);
    assert.deepEqual(
      schedule.items.map(({ id }) => id),
      [FIRST_SCHEDULE_ID],
    );
    assert.equal(schedule.items[0]?.revision, 2);
    browser = await service.getBrowserData({ workspaceId: DEFAULT_WORKSPACE_ID });
    assert.equal(browser.activeTabId, FIRST_BROWSER_TAB_ID);
    assert.equal(browser.tabs[0]?.url, 'https://example.com/packaged');
    assert.equal(browser.bookmarks[0]?.id, FIRST_BROWSER_BOOKMARK_ID);
    assert.equal((await service.getStatus()).backupCount, 1);
  } finally {
    await service?.close().catch(() => undefined);
  }
}

async function smokeVersionOneUpgrade(dataDirectory: string): Promise<void> {
  await mkdir(dataDirectory, { recursive: true });
  const database = createNodeSqliteAdapter(join(dataDirectory, 'daily-workbench.sqlite3'));
  database.open();
  configureDesktopPragmas(database);
  new MigrationRunner([DEFAULT_MIGRATIONS[0]]).apply(database);
  new MetadataRepository(database).initialize(
    FIXED_NOW.toISOString(),
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  );
  database.close();

  const service = new DatabaseService({
    dataDirectory,
    now: () => FIXED_NOW,
    workspaceIdFactory: () => DEFAULT_WORKSPACE_ID,
    browserTabIdFactory: () => FIRST_BROWSER_TAB_ID,
    taskTodayFactory: () => FIXED_TODAY,
    scheduleTodayFactory: () => FIXED_TODAY,
  });
  try {
    const upgraded = await service.open();
    assert.equal(upgraded.migration.fromVersion, 1);
    assert.equal(upgraded.migration.toVersion, 6);
    assert.equal(upgraded.preMigrationBackup?.schemaVersion, 1);
    assert.equal((await service.getWorkspaceSnapshot()).currentWorkspaceId, DEFAULT_WORKSPACE_ID);
    assert.deepEqual(
      (await service.getTaskSnapshot({ workspaceId: DEFAULT_WORKSPACE_ID })).tasks,
      [],
    );
    assert.deepEqual(
      (await service.getNoteSnapshot({ workspaceId: DEFAULT_WORKSPACE_ID })).notes,
      [],
    );
    assert.deepEqual(
      (await service.getScheduleSnapshot({ workspaceId: DEFAULT_WORKSPACE_ID })).items,
      [],
    );
    assert.equal(
      (await service.getBrowserData({ workspaceId: DEFAULT_WORKSPACE_ID })).activeTabId,
      FIRST_BROWSER_TAB_ID,
    );
    const backup = upgraded.preMigrationBackup;
    assert.ok(backup);
    const legacySnapshot = new DatabaseSync(join(dataDirectory, 'backups', backup.fileName), {
      readOnly: true,
    });
    try {
      assert.equal(legacySnapshot.prepare('PRAGMA user_version').get()?.user_version, 1);
      assert.equal(
        legacySnapshot
          .prepare("SELECT COUNT(*) AS count FROM sqlite_schema WHERE name = 'workspaces'")
          .get()?.count,
        0,
      );
    } finally {
      legacySnapshot.close();
    }
  } finally {
    await service.close().catch(() => undefined);
  }
}

async function smokeVersionTwoUpgrade(dataDirectory: string): Promise<void> {
  await mkdir(dataDirectory, { recursive: true });
  const database = createNodeSqliteAdapter(join(dataDirectory, 'daily-workbench.sqlite3'));
  database.open();
  configureDesktopPragmas(database);
  new MigrationRunner(DEFAULT_MIGRATIONS.slice(0, 2)).apply(database);
  new MetadataRepository(database).initialize(
    FIXED_NOW.toISOString(),
    'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  );
  new WorkspaceService({
    execute: async (operation) => operation(database),
    now: () => FIXED_NOW,
    idFactory: () => DEFAULT_WORKSPACE_ID,
  }).initialize(database);
  database.close();

  const service = new DatabaseService({
    dataDirectory,
    now: () => FIXED_NOW,
    inboxIdFactory: () => FIRST_INBOX_ID,
    browserTabIdFactory: () => FIRST_BROWSER_TAB_ID,
    taskTodayFactory: () => FIXED_TODAY,
    scheduleTodayFactory: () => FIXED_TODAY,
  });
  try {
    const upgraded = await service.open();
    assert.equal(upgraded.migration.fromVersion, 2);
    assert.equal(upgraded.migration.toVersion, 6);
    assert.equal(upgraded.preMigrationBackup?.schemaVersion, 2);
    assert.deepEqual(
      (await service.getInboxSnapshot({ workspaceId: DEFAULT_WORKSPACE_ID })).entries,
      [],
    );
    await service.createInboxEntry({
      workspaceId: DEFAULT_WORKSPACE_ID,
      content: 'v2 → v6 打包升级',
      category: 'note',
    });
    assert.deepEqual(
      (await service.getTaskSnapshot({ workspaceId: DEFAULT_WORKSPACE_ID })).tasks,
      [],
    );
    assert.deepEqual(
      (await service.getNoteSnapshot({ workspaceId: DEFAULT_WORKSPACE_ID })).notes,
      [],
    );
    assert.deepEqual(
      (await service.getScheduleSnapshot({ workspaceId: DEFAULT_WORKSPACE_ID })).items,
      [],
    );
    assert.equal(
      (await service.getBrowserData({ workspaceId: DEFAULT_WORKSPACE_ID })).activeTabId,
      FIRST_BROWSER_TAB_ID,
    );

    const backup = upgraded.preMigrationBackup;
    assert.ok(backup);
    const legacySnapshot = new DatabaseSync(join(dataDirectory, 'backups', backup.fileName), {
      readOnly: true,
    });
    try {
      assert.equal(legacySnapshot.prepare('PRAGMA user_version').get()?.user_version, 2);
      assert.equal(
        legacySnapshot
          .prepare("SELECT COUNT(*) AS count FROM sqlite_schema WHERE name = 'inbox_entries'")
          .get()?.count,
        0,
      );
      assert.equal(
        legacySnapshot.prepare('SELECT COUNT(*) AS count FROM workspaces').get()?.count,
        1,
      );
      assert.equal(
        legacySnapshot
          .prepare("SELECT COUNT(*) AS count FROM sqlite_schema WHERE name = 'tasks'")
          .get()?.count,
        0,
      );
    } finally {
      legacySnapshot.close();
    }
  } finally {
    await service.close().catch(() => undefined);
  }
}

async function smokeVersionThreeUpgrade(dataDirectory: string): Promise<void> {
  await mkdir(dataDirectory, { recursive: true });
  const database = createNodeSqliteAdapter(join(dataDirectory, 'daily-workbench.sqlite3'));
  database.open();
  configureDesktopPragmas(database);
  new MigrationRunner(DEFAULT_MIGRATIONS.slice(0, 3)).apply(database);
  new MetadataRepository(database).initialize(
    FIXED_NOW.toISOString(),
    'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
  );
  new WorkspaceService({
    execute: async (operation) => operation(database),
    now: () => FIXED_NOW,
    idFactory: () => DEFAULT_WORKSPACE_ID,
  }).initialize(database);
  const legacyInbox = new InboxService({
    execute: async (operation) => operation(database),
    now: () => FIXED_NOW,
    idFactory: () => FIRST_INBOX_ID,
  });
  await legacyInbox.create({
    workspaceId: DEFAULT_WORKSPACE_ID,
    content: 'v3 保留到显式转换的任务线索 👩‍💻',
    category: 'task',
  });
  database.close();

  const service = new DatabaseService({
    dataDirectory,
    now: () => FIXED_NOW,
    taskIdFactory: () => LEGACY_CONVERTED_TASK_ID,
    browserTabIdFactory: () => FIRST_BROWSER_TAB_ID,
    taskTodayFactory: () => FIXED_TODAY,
    scheduleTodayFactory: () => FIXED_TODAY,
  });
  try {
    const upgraded = await service.open();
    assert.equal(upgraded.migration.fromVersion, 3);
    assert.equal(upgraded.migration.toVersion, 6);
    assert.equal(upgraded.preMigrationBackup?.schemaVersion, 3);
    const beforeConversion = await service.getTaskSnapshot({ workspaceId: DEFAULT_WORKSPACE_ID });
    assert.equal(beforeConversion.todayDate, FIXED_TODAY);
    assert.deepEqual(beforeConversion.tasks, []);
    assert.deepEqual(
      (await service.getNoteSnapshot({ workspaceId: DEFAULT_WORKSPACE_ID })).notes,
      [],
    );
    assert.deepEqual(
      (await service.getScheduleSnapshot({ workspaceId: DEFAULT_WORKSPACE_ID })).items,
      [],
    );
    assert.equal(
      (await service.getBrowserData({ workspaceId: DEFAULT_WORKSPACE_ID })).activeTabId,
      FIRST_BROWSER_TAB_ID,
    );
    const preservedInbox = await service.getInboxSnapshot({ workspaceId: DEFAULT_WORKSPACE_ID });
    assert.equal(preservedInbox.entries.length, 1);
    assert.equal(preservedInbox.entries[0]?.id, FIRST_INBOX_ID);
    assert.equal(preservedInbox.entries[0]?.category, 'task');

    const backup = upgraded.preMigrationBackup;
    assert.ok(backup);
    const legacySnapshot = new DatabaseSync(join(dataDirectory, 'backups', backup.fileName), {
      readOnly: true,
    });
    try {
      assert.equal(legacySnapshot.prepare('PRAGMA user_version').get()?.user_version, 3);
      assert.equal(
        legacySnapshot
          .prepare("SELECT COUNT(*) AS count FROM sqlite_schema WHERE name = 'tasks'")
          .get()?.count,
        0,
      );
      const inboxRow = legacySnapshot
        .prepare('SELECT category, archived_at IS NULL AS active FROM inbox_entries WHERE id = ?')
        .get(FIRST_INBOX_ID);
      assert.equal(inboxRow?.category, 'task');
      assert.equal(inboxRow?.active, 1);
    } finally {
      legacySnapshot.close();
    }

    const converted = await service.convertInboxToTask({
      workspaceId: DEFAULT_WORKSPACE_ID,
      entryId: FIRST_INBOX_ID,
      planning: 'today',
    });
    assert.deepEqual(converted.inboxSnapshot.entries, []);
    assert.equal(converted.taskSnapshot.tasks.length, 1);
    assert.equal(converted.taskSnapshot.tasks[0]?.id, LEGACY_CONVERTED_TASK_ID);
    assert.equal(converted.taskSnapshot.tasks[0]?.title, 'v3 保留到显式转换的任务线索 👩‍💻');
    assert.equal(converted.taskSnapshot.tasks[0]?.sourceInboxEntryId, FIRST_INBOX_ID);
    assert.equal(converted.taskSnapshot.tasks[0]?.plannedFor, FIXED_TODAY);
  } finally {
    await service.close().catch(() => undefined);
  }
}

async function smokeVersionFourUpgrade(dataDirectory: string): Promise<void> {
  await mkdir(dataDirectory, { recursive: true });
  const database = createNodeSqliteAdapter(join(dataDirectory, 'daily-workbench.sqlite3'));
  database.open();
  configureDesktopPragmas(database);
  new MigrationRunner(DEFAULT_MIGRATIONS.slice(0, 4)).apply(database);
  new MetadataRepository(database).initialize(
    FIXED_NOW.toISOString(),
    'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
  );
  const executeLegacy = async <T>(
    operation: (adapter: typeof database) => Promise<T> | T,
  ): Promise<T> => await operation(database);
  new WorkspaceService({
    execute: executeLegacy,
    now: () => FIXED_NOW,
    idFactory: () => DEFAULT_WORKSPACE_ID,
  }).initialize(database);
  const legacyInbox = new InboxService({
    execute: executeLegacy,
    now: () => FIXED_NOW,
    idFactory: () => NOTE_INBOX_ID,
  });
  await legacyInbox.create({
    workspaceId: DEFAULT_WORKSPACE_ID,
    content: 'v4 保留并显式转换的笔记线索 👩‍💻',
    category: 'note',
  });
  const legacyTasks = new TaskService({
    execute: executeLegacy,
    now: () => FIXED_NOW,
    idFactory: () => FIRST_TASK_ID,
    todayFactory: () => FIXED_TODAY,
  });
  await legacyTasks.create({
    workspaceId: DEFAULT_WORKSPACE_ID,
    title: 'v4 必须保留的真实任务',
    planning: 'today',
  });
  database.close();

  let service: DatabaseService | undefined = new DatabaseService({
    dataDirectory,
    now: () => FIXED_NOW,
    noteIdFactory: () => CONVERTED_NOTE_ID,
    scheduleIdFactory: () => FIRST_SCHEDULE_ID,
    browserTabIdFactory: () => FIRST_BROWSER_TAB_ID,
    taskTodayFactory: () => FIXED_TODAY,
    scheduleTodayFactory: () => FIXED_TODAY,
  });
  try {
    const upgraded = await service.open();
    assert.equal(upgraded.migration.fromVersion, 4);
    assert.equal(upgraded.migration.toVersion, 6);
    assert.equal(upgraded.preMigrationBackup?.schemaVersion, 4);
    const preservedInbox = await service.getInboxSnapshot({ workspaceId: DEFAULT_WORKSPACE_ID });
    assert.equal(preservedInbox.entries.length, 1);
    assert.equal(preservedInbox.entries[0]?.id, NOTE_INBOX_ID);
    assert.equal(preservedInbox.entries[0]?.category, 'note');
    const preservedTasks = await service.getTaskSnapshot({ workspaceId: DEFAULT_WORKSPACE_ID });
    assert.equal(preservedTasks.todayDate, FIXED_TODAY);
    assert.equal(preservedTasks.tasks.length, 1);
    assert.equal(preservedTasks.tasks[0]?.id, FIRST_TASK_ID);
    assert.deepEqual(
      (await service.getNoteSnapshot({ workspaceId: DEFAULT_WORKSPACE_ID })).notes,
      [],
    );
    assert.deepEqual(
      (await service.getScheduleSnapshot({ workspaceId: DEFAULT_WORKSPACE_ID })).items,
      [],
    );
    assert.equal(
      (await service.getBrowserData({ workspaceId: DEFAULT_WORKSPACE_ID })).activeTabId,
      FIRST_BROWSER_TAB_ID,
    );

    const backup = upgraded.preMigrationBackup;
    assert.ok(backup);
    const legacySnapshot = new DatabaseSync(join(dataDirectory, 'backups', backup.fileName), {
      readOnly: true,
    });
    try {
      assert.equal(legacySnapshot.prepare('PRAGMA user_version').get()?.user_version, 4);
      assert.equal(
        legacySnapshot.prepare('SELECT COUNT(*) AS count FROM inbox_entries').get()?.count,
        1,
      );
      assert.equal(legacySnapshot.prepare('SELECT COUNT(*) AS count FROM tasks').get()?.count, 1);
      for (const tableName of ['notes', 'schedule_items']) {
        assert.equal(
          legacySnapshot
            .prepare('SELECT COUNT(*) AS count FROM sqlite_schema WHERE name = ?')
            .get(tableName)?.count,
          0,
        );
      }
    } finally {
      legacySnapshot.close();
    }

    const converted = await service.convertInboxToNote({
      workspaceId: DEFAULT_WORKSPACE_ID,
      entryId: NOTE_INBOX_ID,
    });
    assert.deepEqual(converted.inboxSnapshot.entries, []);
    assert.equal(converted.noteSnapshot.notes.length, 1);
    assert.equal(converted.noteSnapshot.notes[0]?.id, CONVERTED_NOTE_ID);
    assert.equal(converted.noteSnapshot.notes[0]?.sourceInboxEntryId, NOTE_INBOX_ID);
    const schedule = await service.createScheduleItem({
      workspaceId: DEFAULT_WORKSPACE_ID,
      expectedDate: FIXED_TODAY,
      title: 'v4 → v6 新增的今日日程',
      kind: 'review',
      startMinute: 13 * 60,
      endMinute: 13 * 60 + 45,
    });
    assert.equal(schedule.items[0]?.id, FIRST_SCHEDULE_ID);
    await service.close();
    service = undefined;

    service = new DatabaseService({
      dataDirectory,
      taskTodayFactory: () => FIXED_TODAY,
      scheduleTodayFactory: () => FIXED_TODAY,
    });
    const reopened = await service.open();
    assert.deepEqual(reopened.migration, { fromVersion: 6, toVersion: 6, applied: [] });
    assert.equal(
      (await service.getTaskSnapshot({ workspaceId: DEFAULT_WORKSPACE_ID })).tasks[0]?.id,
      FIRST_TASK_ID,
    );
    assert.equal(
      (await service.getNoteSnapshot({ workspaceId: DEFAULT_WORKSPACE_ID })).notes[0]
        ?.sourceInboxEntryId,
      NOTE_INBOX_ID,
    );
    assert.equal(
      (await service.getScheduleSnapshot({ workspaceId: DEFAULT_WORKSPACE_ID })).items[0]?.id,
      FIRST_SCHEDULE_ID,
    );
  } finally {
    await service?.close().catch(() => undefined);
  }
}

async function smokeVersionFiveUpgrade(dataDirectory: string): Promise<void> {
  await mkdir(dataDirectory, { recursive: true });
  const database = createNodeSqliteAdapter(join(dataDirectory, 'daily-workbench.sqlite3'));
  database.open();
  configureDesktopPragmas(database);
  new MigrationRunner(DEFAULT_MIGRATIONS.slice(0, 5)).apply(database);
  new MetadataRepository(database).initialize(
    FIXED_NOW.toISOString(),
    '29292929-2929-4929-8929-292929292929',
  );
  const executeLegacy = async <T>(
    operation: (adapter: typeof database) => Promise<T> | T,
  ): Promise<T> => await operation(database);
  new WorkspaceService({
    execute: executeLegacy,
    now: () => FIXED_NOW,
    idFactory: () => DEFAULT_WORKSPACE_ID,
  }).initialize(database);
  await new NoteService({
    execute: executeLegacy,
    now: () => FIXED_NOW,
    idFactory: () => FIRST_NOTE_ID,
  }).create({
    workspaceId: DEFAULT_WORKSPACE_ID,
    title: 'v5 必须保留的 Markdown 笔记',
    body: '# v5 → v6',
  });
  await new ScheduleService({
    execute: executeLegacy,
    now: () => FIXED_NOW,
    idFactory: () => FIRST_SCHEDULE_ID,
    todayFactory: () => FIXED_TODAY,
  }).create({
    workspaceId: DEFAULT_WORKSPACE_ID,
    expectedDate: FIXED_TODAY,
    title: 'v5 必须保留的日程',
    kind: 'review',
    startMinute: 14 * 60,
    endMinute: 15 * 60,
  });
  database.close();

  const service = new DatabaseService({
    dataDirectory,
    now: () => FIXED_NOW,
    browserTabIdFactory: () => FOURTH_BROWSER_TAB_ID,
    taskTodayFactory: () => FIXED_TODAY,
    scheduleTodayFactory: () => FIXED_TODAY,
  });
  try {
    const upgraded = await service.open();
    assert.equal(upgraded.migration.fromVersion, 5);
    assert.equal(upgraded.migration.toVersion, 6);
    assert.equal(upgraded.preMigrationBackup?.schemaVersion, 5);
    assert.equal(
      (await service.getNoteSnapshot({ workspaceId: DEFAULT_WORKSPACE_ID })).notes[0]?.id,
      FIRST_NOTE_ID,
    );
    assert.equal(
      (await service.getScheduleSnapshot({ workspaceId: DEFAULT_WORKSPACE_ID })).items[0]?.id,
      FIRST_SCHEDULE_ID,
    );
    assert.equal(
      (await service.getBrowserData({ workspaceId: DEFAULT_WORKSPACE_ID })).activeTabId,
      FOURTH_BROWSER_TAB_ID,
    );

    const backup = upgraded.preMigrationBackup;
    assert.ok(backup);
    const legacySnapshot = new DatabaseSync(join(dataDirectory, 'backups', backup.fileName), {
      readOnly: true,
    });
    try {
      assert.equal(legacySnapshot.prepare('PRAGMA user_version').get()?.user_version, 5);
      assert.equal(legacySnapshot.prepare('SELECT COUNT(*) AS count FROM notes').get()?.count, 1);
      assert.equal(
        legacySnapshot.prepare('SELECT COUNT(*) AS count FROM schedule_items').get()?.count,
        1,
      );
      assert.equal(
        legacySnapshot
          .prepare("SELECT COUNT(*) AS count FROM sqlite_schema WHERE name = 'browser_tabs'")
          .get()?.count,
        0,
      );
    } finally {
      legacySnapshot.close();
    }
  } finally {
    await service.close().catch(() => undefined);
  }
}

async function removeSmokeDirectory(root: string): Promise<void> {
  const expectedPrefix = join(tmpdir(), 'daily workbench 服务 smoke-');
  assert.ok(root.startsWith(expectedPrefix), `Refusing to clean an unexpected path: ${root}`);
  await rm(root, {
    recursive: true,
    force: true,
    maxRetries: process.platform === 'win32' ? 5 : 0,
    retryDelay: 200,
  });
}

void main().catch((error: unknown) => {
  console.error('Packaged DatabaseService smoke test failed.', error);
  process.exitCode = 1;
});
