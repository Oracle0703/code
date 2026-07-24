import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { WORKSPACE_COLORS, type BackupPolicy, type SearchSnapshot } from '../src/shared/contracts';
import { createRollingPlanningDays } from '../src/shared/planning-domain';
import {
  DatabaseReplacementRecovery,
  FileReplacementMarkerPersistence,
} from '../src/main/data-management';
import { DatabaseService } from '../src/main/database';
import { DEFAULT_MIGRATIONS } from '../src/main/database/default-migrations';
import { MetadataRepository } from '../src/main/database/metadata-repository';
import { MigrationRunner } from '../src/main/database/migration-runner';
import {
  configureDesktopPragmas,
  createNodeSqliteAdapter,
} from '../src/main/database/sqlite-adapter';
import {
  AtomicImportStager,
  DatabaseImportStagingDriver,
  ReplacementMarkerStore,
  type PortableDataRecord,
  parsePortablePackage,
  serializePortablePackage,
} from '../src/main/data-portability';
import { AutomationController } from '../src/main/automations';
import { FocusController } from '../src/main/focus';
import { InboxService } from '../src/main/inbox';
import { BrowserService } from '../src/main/browser';
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
const PORTABLE_EXPORT_ID = '31313131-3131-4131-8131-313131313131';
const PORTABLE_IMPORT_ID = '32323232-3232-4232-8232-323232323232';
const PORTABLE_STAGING_ID = '33333333-3333-4333-8333-333333333333';
const PORTABLE_DATABASE_ID = '34343434-3434-4434-8434-343434343434';
const DAILY_AUTOMATION_ID = '35353535-3535-4535-8535-353535353535';
const WEEKLY_AUTOMATION_ID = '36363636-3636-4636-8636-363636363636';
const AUTOMATION_TASK_ID = '37373737-3737-4737-8737-373737373737';
const AUTOMATION_NOTE_ID = '38383838-3838-4838-8838-383838383838';
const FOCUS_SESSION_ID = '40404040-4040-4040-8040-404040404040';
const BACKUP_RESTORE_TASK_ID = '51515151-5151-4151-8151-515151515151';
const BACKUP_RESTORE_AUTOMATION_ID = '52525252-5252-4252-8252-525252525252';
const BACKUP_RESTORE_FOCUS_ID = '53535353-5353-4353-8353-535353535353';
const BACKUP_RESTORE_POST_TASK_ID = '54545454-5454-4454-8454-545454545454';
const BACKUP_RESTORE_PAUSED_ID = '56565656-5656-4656-8656-565656565656';
const BACKUP_RESTORE_COMMITTED_ID = '57575757-5757-4757-8757-575757575757';
const FIXED_NOW = new Date('2026-07-22T12:34:56.000Z');
const FIXED_TODAY = '2026-07-22';
const FIXED_DAY_SIX = '2026-07-28';
const FIXED_DAY_SEVEN = '2026-07-29';
const FIXED_PLANNING_DAYS = createRollingPlanningDays(FIXED_TODAY);

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
    await smokeVersionSixUpgrade(join(root, 'legacy v6 数据'));
    await smokeVersionSevenUpgrade(join(root, 'legacy v7 数据'));
    await smokeVersionEightUpgrade(join(root, 'legacy v8 数据'));
    await smokeVersionNineUpgrade(join(root, 'legacy v9 数据'));
    await smokeVersionTenUpgrade(join(root, 'legacy v10 数据'));
    await smokeBackupPointInTimeRestore(join(root, 'backup restore 数据'));
    console.log(
      `Packaged DatabaseService workspace/inbox/task/note/schedule/browser/search/terminal-preferences/automation/focus/migration/scheduled-backup/backup-restore/portable-round-trip/reopen smoke test passed ` +
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
  const automationIds = [DAILY_AUTOMATION_ID, WEEKLY_AUTOMATION_ID];
  let serviceNow = FIXED_NOW;
  let service: DatabaseService | undefined = new DatabaseService({
    dataDirectory,
    now: () => serviceNow,
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
    automationIdFactory: () => automationIds.shift() ?? '39393939-3939-4939-8939-393939393939',
    automationTaskIdFactory: () => AUTOMATION_TASK_ID,
    automationNoteIdFactory: () => AUTOMATION_NOTE_ID,
    focusIdFactory: () => FOCUS_SESSION_ID,
    focusTodayFactory: () => FIXED_TODAY,
  });

  try {
    const initialized = await service.open();
    assert.equal(initialized.migration.fromVersion, 0);
    assert.equal(initialized.migration.toVersion, 11);
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
        schemaVersion: 11,
        appliedMigrations: 11,
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
    let terminalPreferences = await service.getTerminalPreferences(DEFAULT_WORKSPACE_ID);
    assert.deepEqual(
      {
        preferredProfileId: terminalPreferences.preferredProfileId,
        nativeCwdPlatform: terminalPreferences.nativeCwdPlatform,
        nativeCwdPath: terminalPreferences.nativeCwdPath,
        wslDistributionName: terminalPreferences.wslDistributionName,
        revision: terminalPreferences.revision,
      },
      {
        preferredProfileId: 'system-default',
        nativeCwdPlatform: null,
        nativeCwdPath: null,
        wslDistributionName: null,
        revision: 1,
      },
    );
    terminalPreferences = await service.updateTerminalProfilePreference({
      workspaceId: DEFAULT_WORKSPACE_ID,
      preferredProfileId: 'bash',
      expectedRevision: terminalPreferences.revision,
    });
    terminalPreferences = await service.updateTerminalWorkingDirectoryPreference({
      workspaceId: DEFAULT_WORKSPACE_ID,
      nativeCwdPlatform:
        process.platform === 'win32' ? 'win32' : process.platform === 'darwin' ? 'darwin' : 'linux',
      nativeCwdPath: dataDirectory,
      expectedRevision: terminalPreferences.revision,
    });
    terminalPreferences = await service.updateTerminalWslDistributionPreference({
      workspaceId: DEFAULT_WORKSPACE_ID,
      wslDistributionName: 'Ubuntu-开发',
      expectedRevision: terminalPreferences.revision,
    });
    assert.deepEqual(
      {
        preferredProfileId: terminalPreferences.preferredProfileId,
        nativeCwdPath: terminalPreferences.nativeCwdPath,
        wslDistributionName: terminalPreferences.wslDistributionName,
        revision: terminalPreferences.revision,
      },
      {
        preferredProfileId: 'bash',
        nativeCwdPath: dataDirectory,
        wslDistributionName: 'Ubuntu-开发',
        revision: 4,
      },
    );
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
    assert.deepEqual(tasks.planningDays, FIXED_PLANNING_DAYS);
    assert.deepEqual(tasks.tasks, []);
    tasks = await service.createTask({
      workspaceId: DEFAULT_WORKSPACE_ID,
      title: '  打包后的任务 / e\u0301 / 👩‍💻  ',
      planning: 'day-0',
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
      planning: 'day-6',
    });
    task = tasks.tasks.find(({ id }) => id === SECOND_TASK_ID);
    assert.ok(task);
    assert.equal(task.plannedFor, FIXED_DAY_SIX);
    await assert.rejects(
      service.startFocusSession({
        workspaceId: DEFAULT_WORKSPACE_ID,
        taskId: SECOND_TASK_ID,
      }),
      {
        name: 'FocusConflictError',
        message: 'A focus task must be unfinished and planned for today in this workspace.',
      },
    );
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
      planning: 'day-0',
    });
    assert.equal(tasks.tasks.find(({ id }) => id === SECOND_TASK_ID)?.plannedFor, FIXED_TODAY);
    const taskValidationService = service;
    assert.throws(
      () =>
        taskValidationService.updateTaskPlanning({
          workspaceId: DEFAULT_WORKSPACE_ID,
          taskId: SECOND_TASK_ID,
          planning: 'today' as never,
        }),
      {
        name: 'TaskValidationError',
        message: 'Task planning value is invalid.',
      },
    );
    assert.throws(
      () =>
        taskValidationService.updateTaskPlanning({
          workspaceId: DEFAULT_WORKSPACE_ID,
          taskId: SECOND_TASK_ID,
          planning: 'day-7' as never,
        }),
      {
        name: 'TaskValidationError',
        message: 'Task planning value is invalid.',
      },
    );
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
    assert.deepEqual(schedule.planningDays, FIXED_PLANNING_DAYS);
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
      expectedDate: FIXED_DAY_SIX,
      title: '待归档的个人安排',
      kind: 'personal',
      startMinute: 18 * 60,
      endMinute: 19 * 60,
    });
    assert.equal(
      schedule.items.some(({ id }) => id === SECOND_SCHEDULE_ID),
      true,
    );
    assert.equal(
      schedule.items.find(({ id }) => id === SECOND_SCHEDULE_ID)?.scheduledFor,
      FIXED_DAY_SIX,
    );
    schedule = await service.updateScheduleItem({
      workspaceId: DEFAULT_WORKSPACE_ID,
      scheduleId: SECOND_SCHEDULE_ID,
      expectedDate: FIXED_DAY_SIX,
      expectedRevision: 1,
      title: '六日后的个人回顾',
      kind: 'review',
      startMinute: 18 * 60 + 15,
      endMinute: 19 * 60 + 15,
    });
    assert.equal(schedule.items.find(({ id }) => id === SECOND_SCHEDULE_ID)?.revision, 2);
    const daySixSearch = await service.search({
      workspaceId: DEFAULT_WORKSPACE_ID,
      query: '六日后的个人回顾',
      scope: 'workspace',
    });
    assert.deepEqual(
      daySixSearch.results.map(({ kind, entityId }) => ({
        kind,
        entityId,
      })),
      [{ kind: 'schedule', entityId: SECOND_SCHEDULE_ID }],
    );
    await assert.rejects(
      service.updateScheduleItem({
        workspaceId: DEFAULT_WORKSPACE_ID,
        scheduleId: SECOND_SCHEDULE_ID,
        expectedDate: FIXED_DAY_SEVEN,
        expectedRevision: 2,
        title: '窗口外安排',
        kind: 'personal',
        startMinute: 18 * 60,
        endMinute: 19 * 60,
      }),
      {
        name: 'ScheduleConflictError',
        message:
          'The selected schedule date is outside the current planning window. Reload the plan first.',
      },
    );
    schedule = await service.archiveScheduleItem({
      workspaceId: DEFAULT_WORKSPACE_ID,
      scheduleId: SECOND_SCHEDULE_ID,
      expectedDate: FIXED_DAY_SIX,
      expectedRevision: 2,
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
    assert.deepEqual(await service.getTerminalPreferences(SECOND_WORKSPACE_ID), {
      workspaceId: SECOND_WORKSPACE_ID,
      preferredProfileId: 'system-default',
      nativeCwdPlatform: null,
      nativeCwdPath: null,
      wslDistributionName: null,
      revision: 1,
      updatedAt: FIXED_NOW.toISOString(),
    });
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
      planning: 'day-0',
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
    const focusController = createManualFocusController(service, () => serviceNow);
    await focusController.start();
    let focus = await focusController.startSession({
      workspaceId: DEFAULT_WORKSPACE_ID,
      taskId: CONVERTED_TASK_ID,
    });
    assert.equal(focus.session?.id, FOCUS_SESSION_ID);
    assert.equal(focus.session?.workspaceId, DEFAULT_WORKSPACE_ID);
    assert.equal(focus.session?.taskId, CONVERTED_TASK_ID);
    assert.equal(focus.session?.status, 'running');
    assert.equal(focus.session?.remainingSeconds, 1_500);
    assert.equal(focus.session?.revision, 1);
    assert.equal(focus.todayCompletedCount, 0);
    focus = await focusController.pauseSession({
      workspaceId: DEFAULT_WORKSPACE_ID,
      sessionId: FOCUS_SESSION_ID,
      expectedRevision: 1,
    });
    assert.equal(focus.session?.status, 'paused');
    assert.equal(focus.session?.remainingSeconds, 1_500);
    assert.equal(focus.session?.deadlineAt, null);
    assert.equal(focus.session?.revision, 2);
    focus = await focusController.resumeSession({
      workspaceId: DEFAULT_WORKSPACE_ID,
      sessionId: FOCUS_SESSION_ID,
      expectedRevision: 2,
    });
    assert.equal(focus.session?.status, 'running');
    assert.equal(focus.session?.remainingSeconds, 1_500);
    assert.equal(focus.session?.revision, 3);
    assert.ok(focus.session?.deadlineAt);
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
    const archivedWorkspaceSnapshot = await service.getWorkspaceArchiveSnapshot();
    assert.deepEqual(
      archivedWorkspaceSnapshot.archivedWorkspaces.map(({ id, name, archivedAt, revision }) => ({
        id,
        name,
        archivedAt,
        revision,
      })),
      [
        {
          id: SECOND_WORKSPACE_ID,
          name: '研发工作区 🧪',
          archivedAt: FIXED_NOW.toISOString(),
          revision: 2,
        },
      ],
    );
    await assert.rejects(
      service.restoreWorkspace({
        workspaceId: SECOND_WORKSPACE_ID,
        expectedRevision: 1,
        name: '不应被旧请求恢复',
      }),
      {
        name: 'WorkspaceConflictError',
        message: 'The archived workspace changed. Reload and retry.',
      },
    );
    await assert.rejects(
      service.restoreWorkspace({
        workspaceId: SECOND_WORKSPACE_ID,
        expectedRevision: 2,
        name: '我的工作台',
      }),
      {
        name: 'WorkspaceConflictError',
        message: 'An active workspace already uses this name.',
      },
    );
    assert.deepEqual(
      (await service.getWorkspaceSnapshot()).workspaces.map(({ id }) => id),
      [DEFAULT_WORKSPACE_ID],
    );
    await assert.rejects(service.getBrowserData({ workspaceId: SECOND_WORKSPACE_ID }));

    const shortSearch = await service.search({
      workspaceId: DEFAULT_WORKSPACE_ID,
      query: '任务',
      scope: 'workspace',
    });
    assert.equal(shortSearch.query, '任务');
    assert.equal(shortSearch.truncated, false);
    assert.equal(
      shortSearch.results.every(
        ({ kind, workspaceId }) => kind === 'task' && workspaceId === DEFAULT_WORKSPACE_ID,
      ),
      true,
    );
    assert.deepEqual(
      shortSearch.results.map(({ entityId }) => entityId).sort(),
      [FIRST_TASK_ID, SECOND_TASK_ID].sort(),
    );

    const fullTextSearch = await service.search({
      workspaceId: DEFAULT_WORKSPACE_ID,
      query: '来自收件箱',
      scope: 'workspace',
    });
    assert.equal(fullTextSearch.query, '来自收件箱');
    assert.equal(fullTextSearch.truncated, false);
    assert.deepEqual(
      fullTextSearch.results.map(({ kind, entityId, matchField }) => ({
        kind,
        entityId,
        matchField,
      })),
      [{ kind: 'note', entityId: CONVERTED_NOTE_ID, matchField: 'title' }],
    );

    const initialBackupState = await service.getBackupSchedulerState();
    assert.deepEqual(
      {
        policy: initialBackupState.policy,
        lastAttemptAt: initialBackupState.lastAttemptAt,
        lastSuccessAt: initialBackupState.lastSuccessAt,
        lastSuccessBucket: initialBackupState.lastSuccessBucket,
        lastErrorCode: initialBackupState.lastErrorCode,
        consecutiveFailures: initialBackupState.consecutiveFailures,
      },
      {
        policy: {
          enabled: false,
          cadence: 'daily',
          localTimeMinute: 120,
          weekday: null,
          retentionCount: 14,
          revision: 1,
          updatedAt: FIXED_NOW.toISOString(),
        },
        lastAttemptAt: null,
        lastSuccessAt: null,
        lastSuccessBucket: null,
        lastErrorCode: null,
        consecutiveFailures: 0,
      },
    );
    const backupPolicy = await service.updateBackupPolicy({
      enabled: true,
      cadence: 'weekly',
      localTimeMinute: 7 * 60 + 15,
      weekday: 4,
      retentionCount: 1,
      expectedRevision: initialBackupState.policy.revision,
    });
    assert.deepEqual(backupPolicy, {
      enabled: true,
      cadence: 'weekly',
      localTimeMinute: 7 * 60 + 15,
      weekday: 4,
      retentionCount: 1,
      revision: 2,
      updatedAt: FIXED_NOW.toISOString(),
    });

    const automationOccurrences = await smokeScheduledAutomations(service, (value) => {
      serviceNow = value;
    });

    const created = await service.createBackup();
    assert.equal(created.reason, 'manual');
    assert.equal(created.schemaVersion, 11);
    assert.equal('path' in created, false);
    const scheduled = await service.createScheduledBackup();
    assert.equal(scheduled.reason, 'scheduled');
    assert.equal(scheduled.schemaVersion, 11);
    assert.equal('path' in scheduled, false);
    assert.deepEqual(await service.validateExistingBackup(scheduled.id, 'scheduled'), scheduled);
    assert.deepEqual(await service.pruneScheduledBackups(scheduled.id), {
      deleted: 0,
      retained: 1,
    });
    const listedBackups = (await service.listBackups())
      .map(({ id, reason }) => ({ id, reason }))
      .sort((left, right) => left.reason.localeCompare(right.reason));
    assert.deepEqual(listedBackups, [
      { id: created.id, reason: 'manual' },
      { id: scheduled.id, reason: 'scheduled' },
    ]);
    await smokePortableRoundTrip(
      join(dataDirectory, 'portable round trip 数据'),
      service,
      backupPolicy,
      [shortSearch, fullTextSearch],
      serviceNow,
    );
    // Deliberately bypass FocusController.stop(): graceful shutdown pauses a
    // running session, while this close simulates process loss so reopen must
    // reconcile the expired deadline exactly once.
    await service.close();
    service = undefined;

    const backupPath = join(dataDirectory, 'backups', created.fileName);
    const backup = new DatabaseSync(backupPath, { readOnly: true });
    try {
      assert.equal(backup.prepare('PRAGMA user_version').get()?.user_version, 11);
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
      assert.equal(backup.prepare('SELECT COUNT(*) AS count FROM tasks').get()?.count, 5);
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
      assert.equal(backup.prepare('SELECT COUNT(*) AS count FROM notes').get()?.count, 4);
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
          `SELECT title, kind, scheduled_for, start_minute, end_minute, revision,
                  archived_at IS NOT NULL AS archived
           FROM schedule_items
           WHERE id = ?`,
        )
        .get(SECOND_SCHEDULE_ID);
      assert.equal(archivedScheduleRow?.title, '六日后的个人回顾');
      assert.equal(archivedScheduleRow?.kind, 'review');
      assert.equal(archivedScheduleRow?.scheduled_for, FIXED_DAY_SIX);
      assert.equal(archivedScheduleRow?.start_minute, 18 * 60 + 15);
      assert.equal(archivedScheduleRow?.end_minute, 19 * 60 + 15);
      assert.equal(archivedScheduleRow?.revision, 3);
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
      assert.equal(
        backup.prepare('SELECT COUNT(*) AS count FROM workspace_terminal_preferences').get()?.count,
        2,
      );
      const terminalPreferenceRow = backup
        .prepare(
          `SELECT preferred_profile_id, native_cwd_platform, native_cwd_path,
                  wsl_distribution_name, revision
           FROM workspace_terminal_preferences
           WHERE workspace_id = ?`,
        )
        .get(DEFAULT_WORKSPACE_ID);
      assert.equal(terminalPreferenceRow?.preferred_profile_id, 'bash');
      assert.equal(
        terminalPreferenceRow?.native_cwd_platform,
        process.platform === 'win32' ? 'win32' : process.platform === 'darwin' ? 'darwin' : 'linux',
      );
      assert.equal(terminalPreferenceRow?.native_cwd_path, dataDirectory);
      assert.equal(terminalPreferenceRow?.wsl_distribution_name, 'Ubuntu-开发');
      assert.equal(terminalPreferenceRow?.revision, 4);
      assert.equal(backup.prepare('SELECT COUNT(*) AS count FROM automations').get()?.count, 2);
      assert.equal(
        backup
          .prepare(
            `SELECT COUNT(*) AS count
             FROM automations
             WHERE enabled = 1 AND effective_at IS NOT NULL AND archived_at IS NULL`,
          )
          .get()?.count,
        2,
      );
      assert.equal(
        backup
          .prepare(
            `SELECT COUNT(*) AS count
             FROM automation_run_state
             WHERE last_success_at IS NOT NULL
               AND last_success_occurrence IS NOT NULL
               AND last_error_code IS NULL`,
          )
          .get()?.count,
        2,
      );
      assert.equal(
        backup.prepare('SELECT COUNT(*) AS count FROM automation_occurrences').get()?.count,
        2,
      );
      assert.deepEqual(
        backup
          .prepare(
            `SELECT automation_id AS automationId, occurrence_date AS occurrenceDate,
                    output_kind AS outputKind, task_id AS taskId, note_id AS noteId
             FROM automation_occurrences
             ORDER BY automation_id`,
          )
          .all()
          .map((row) => ({ ...row })),
        [
          {
            automationId: DAILY_AUTOMATION_ID,
            occurrenceDate: automationOccurrences.daily,
            outputKind: 'task',
            taskId: AUTOMATION_TASK_ID,
            noteId: null,
          },
          {
            automationId: WEEKLY_AUTOMATION_ID,
            occurrenceDate: automationOccurrences.weekly,
            outputKind: 'note',
            taskId: null,
            noteId: AUTOMATION_NOTE_ID,
          },
        ],
      );
      assert.equal(backup.prepare('SELECT COUNT(*) AS count FROM focus_sessions').get()?.count, 1);
      const backupFocusRow = backup
        .prepare(
          `SELECT id, workspace_id AS workspaceId, task_id AS taskId,
                  local_date AS localDate, state, remaining_seconds AS remainingSeconds,
                  deadline_at AS deadlineAt, revision, completed_at AS completedAt,
                  cancelled_at AS cancelledAt
           FROM focus_sessions`,
        )
        .get();
      assert.deepEqual(backupFocusRow ? { ...backupFocusRow } : undefined, {
        id: FOCUS_SESSION_ID,
        workspaceId: DEFAULT_WORKSPACE_ID,
        taskId: CONVERTED_TASK_ID,
        localDate: FIXED_TODAY,
        state: 'running',
        remainingSeconds: 1_500,
        deadlineAt: new Date(FIXED_NOW.getTime() + 25 * 60_000).toISOString(),
        revision: 3,
        completedAt: null,
        cancelledAt: null,
      });
    } finally {
      backup.close();
    }

    const scheduledBackupPath = join(dataDirectory, 'backups', scheduled.fileName);
    const scheduledBackup = new DatabaseSync(scheduledBackupPath, { readOnly: true });
    try {
      assert.equal(scheduledBackup.prepare('PRAGMA user_version').get()?.user_version, 11);
      assert.equal(scheduledBackup.prepare('PRAGMA quick_check').get()?.quick_check, 'ok');
      assert.equal(scheduledBackup.prepare('SELECT COUNT(*) AS count FROM tasks').get()?.count, 5);
      assert.equal(scheduledBackup.prepare('SELECT COUNT(*) AS count FROM notes').get()?.count, 4);
      assert.equal(
        scheduledBackup.prepare('SELECT COUNT(*) AS count FROM automation_occurrences').get()
          ?.count,
        2,
      );
      assert.equal(
        scheduledBackup.prepare('SELECT COUNT(*) AS count FROM focus_sessions').get()?.count,
        1,
      );
    } finally {
      scheduledBackup.close();
    }

    service = new DatabaseService({
      dataDirectory,
      now: () => serviceNow,
      taskTodayFactory: () => FIXED_TODAY,
      scheduleTodayFactory: () => FIXED_TODAY,
      focusTodayFactory: () => FIXED_TODAY,
    });
    const reopened = await service.open();
    assert.equal(reopened.migration.fromVersion, 11);
    assert.equal(reopened.migration.toVersion, 11);
    assert.equal(reopened.migration.applied.length, 0);
    const reopenedFocusController = createManualFocusController(service, () => serviceNow);
    await reopenedFocusController.start();
    const completedFocus = await reopenedFocusController.getSnapshot({
      workspaceId: DEFAULT_WORKSPACE_ID,
    });
    assert.equal(completedFocus.session, null);
    assert.equal(completedFocus.todayCompletedCount, 1);
    await reopenedFocusController.stop();
    const reopenedAutomationController = createManualAutomationController(
      service,
      () => serviceNow,
    );
    await reopenedAutomationController.start();
    await reopenedAutomationController.evaluate();
    await reopenedAutomationController.stop();
    snapshot = await service.getWorkspaceSnapshot();
    assert.equal(snapshot.currentWorkspaceId, DEFAULT_WORKSPACE_ID);
    assert.equal(snapshot.workspaces.length, 1);
    assert.equal(snapshot.preferences.theme, 'light');
    inbox = await service.getInboxSnapshot({ workspaceId: DEFAULT_WORKSPACE_ID });
    assert.deepEqual(inbox.entries, []);
    tasks = await service.getTaskSnapshot({ workspaceId: DEFAULT_WORKSPACE_ID });
    assert.equal(tasks.todayDate, FIXED_TODAY);
    assert.equal(tasks.tasks.length, 4);
    assert.equal(tasks.tasks.find(({ id }) => id === FIRST_TASK_ID)?.status, 'completed');
    assert.equal(
      tasks.tasks.find(({ id }) => id === CONVERTED_TASK_ID)?.sourceInboxEntryId,
      FIRST_INBOX_ID,
    );
    assert.equal(tasks.tasks.find(({ id }) => id === SECOND_TASK_ID)?.plannedFor, null);
    assert.equal(tasks.tasks.find(({ id }) => id === AUTOMATION_TASK_ID)?.status, 'todo');
    notes = await service.getNoteSnapshot({ workspaceId: DEFAULT_WORKSPACE_ID });
    assert.deepEqual(
      new Set(notes.notes.map(({ id }) => id)),
      new Set([CONVERTED_NOTE_ID, AUTOMATION_NOTE_ID]),
    );
    assert.equal(
      notes.notes.find(({ id }) => id === CONVERTED_NOTE_ID)?.sourceInboxEntryId,
      NOTE_INBOX_ID,
    );
    const reopenedAutomations = await service.getAutomationSnapshot({
      workspaceId: DEFAULT_WORKSPACE_ID,
    });
    assert.equal(reopenedAutomations.items.length, 2);
    assert.equal(
      reopenedAutomations.items.filter(({ lastRun }) => lastRun.status === 'success').length,
      2,
    );
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
    terminalPreferences = await service.getTerminalPreferences(DEFAULT_WORKSPACE_ID);
    assert.deepEqual(
      {
        preferredProfileId: terminalPreferences.preferredProfileId,
        nativeCwdPath: terminalPreferences.nativeCwdPath,
        wslDistributionName: terminalPreferences.wslDistributionName,
        revision: terminalPreferences.revision,
      },
      {
        preferredProfileId: 'bash',
        nativeCwdPath: dataDirectory,
        wslDistributionName: 'Ubuntu-开发',
        revision: 4,
      },
    );
    assert.equal((await service.getStatus()).backupCount, 2);
    assert.deepEqual((await service.getBackupSchedulerState()).policy, backupPolicy);
    assert.deepEqual(
      await service.search({
        workspaceId: DEFAULT_WORKSPACE_ID,
        query: shortSearch.query,
        scope: shortSearch.scope,
      }),
      shortSearch,
    );
    assert.deepEqual(
      await service.search({
        workspaceId: DEFAULT_WORKSPACE_ID,
        query: fullTextSearch.query,
        scope: fullTextSearch.scope,
      }),
      fullTextSearch,
    );

    const reopenedArchive = await service.getWorkspaceArchiveSnapshot();
    assert.equal(reopenedArchive.archivedWorkspaces.length, 1);
    assert.equal(reopenedArchive.archivedWorkspaces[0]?.id, SECOND_WORKSPACE_ID);
    assert.equal(reopenedArchive.archivedWorkspaces[0]?.revision, 2);
    const restored = await service.restoreWorkspace({
      workspaceId: SECOND_WORKSPACE_ID,
      expectedRevision: reopenedArchive.archivedWorkspaces[0]?.revision ?? 0,
      name: '已恢复的研发工作区 🧪',
    });
    assert.equal(restored.workspaceSnapshot.currentWorkspaceId, DEFAULT_WORKSPACE_ID);
    assert.deepEqual(
      restored.workspaceSnapshot.workspaces.map(({ id }) => id),
      [DEFAULT_WORKSPACE_ID, SECOND_WORKSPACE_ID],
    );
    assert.deepEqual(restored.archiveSnapshot.archivedWorkspaces, []);
    assert.deepEqual(await service.getInboxSnapshot({ workspaceId: SECOND_WORKSPACE_ID }), {
      workspaceId: SECOND_WORKSPACE_ID,
      entries: [],
    });
    assert.equal(
      (await service.getTaskSnapshot({ workspaceId: SECOND_WORKSPACE_ID })).tasks[0]?.id,
      THIRD_TASK_ID,
    );
    assert.equal(
      (await service.getNoteSnapshot({ workspaceId: SECOND_WORKSPACE_ID })).notes[0]?.id,
      SECOND_NOTE_ID,
    );
    assert.equal(
      (await service.getScheduleSnapshot({ workspaceId: SECOND_WORKSPACE_ID })).items[0]?.id,
      THIRD_SCHEDULE_ID,
    );
    assert.equal(
      (await service.getBrowserData({ workspaceId: SECOND_WORKSPACE_ID })).activeTabId,
      THIRD_BROWSER_TAB_ID,
    );
    assert.equal(
      (await service.getTerminalPreferences(SECOND_WORKSPACE_ID)).preferredProfileId,
      'system-default',
    );
  } finally {
    await service?.close().catch(() => undefined);
  }
}

async function smokeScheduledAutomations(
  service: DatabaseService,
  setNow: (value: Date) => void,
): Promise<{ readonly daily: string; readonly weekly: string }> {
  const fixedLocalMinute = FIXED_NOW.getHours() * 60 + FIXED_NOW.getMinutes();
  assert.ok(fixedLocalMinute <= 1_436, 'The fixed automation smoke time must leave three minutes.');

  let automations = await service.createAutomation({
    workspaceId: DEFAULT_WORKSPACE_ID,
    name: '每日自动创建今日任务',
    schedule: {
      cadence: 'daily',
      localTimeMinute: fixedLocalMinute + 1,
      weekday: null,
    },
    action: {
      kind: 'create-today-task',
      title: '自动生成的待办',
    },
  });
  let daily = automations.items.find(({ id }) => id === DAILY_AUTOMATION_ID);
  assert.ok(daily);
  assert.equal(daily.enabled, false);
  assert.equal(daily.revision, 1);
  assert.deepEqual(daily.lastRun, { status: 'never' });

  automations = await service.createAutomation({
    workspaceId: DEFAULT_WORKSPACE_ID,
    name: '每周自动创建笔记',
    schedule: {
      cadence: 'weekly',
      localTimeMinute: fixedLocalMinute + 2,
      weekday: FIXED_NOW.getDay(),
    },
    action: {
      kind: 'create-note',
      title: '自动生成的周记',
      body: '由受控定时自动化创建。',
    },
  });
  const weekly = automations.items.find(({ id }) => id === WEEKLY_AUTOMATION_ID);
  assert.ok(weekly);
  assert.equal(weekly.enabled, false);
  assert.deepEqual(weekly.lastRun, { status: 'never' });

  automations = await service.setAutomationEnabled({
    workspaceId: DEFAULT_WORKSPACE_ID,
    automationId: DAILY_AUTOMATION_ID,
    expectedRevision: daily.revision,
    enabled: true,
  });
  daily = automations.items.find(({ id }) => id === DAILY_AUTOMATION_ID);
  assert.ok(daily);
  assert.equal(daily.enabled, true);
  assert.equal(daily.revision, 2);

  automations = await service.setAutomationEnabled({
    workspaceId: DEFAULT_WORKSPACE_ID,
    automationId: WEEKLY_AUTOMATION_ID,
    expectedRevision: weekly.revision,
    enabled: true,
  });
  assert.equal(automations.items.find(({ id }) => id === WEEKLY_AUTOMATION_ID)?.enabled, true);

  const catchUpNow = new Date(FIXED_NOW);
  catchUpNow.setDate(catchUpNow.getDate() + 8);
  catchUpNow.setMinutes(catchUpNow.getMinutes() + 3);
  setNow(catchUpNow);

  const controller = createManualAutomationController(service, () => catchUpNow);
  await controller.start();
  await controller.evaluate();

  automations = await service.getAutomationSnapshot({ workspaceId: DEFAULT_WORKSPACE_ID });
  assert.equal(automations.items.filter(({ lastRun }) => lastRun.status === 'success').length, 2);
  const tasksAfterFirstEvaluation = await service.getTaskSnapshot({
    workspaceId: DEFAULT_WORKSPACE_ID,
  });
  const notesAfterFirstEvaluation = await service.getNoteSnapshot({
    workspaceId: DEFAULT_WORKSPACE_ID,
  });
  assert.equal(
    tasksAfterFirstEvaluation.tasks.find(({ id }) => id === AUTOMATION_TASK_ID)?.title,
    '自动生成的待办',
  );
  assert.equal(
    notesAfterFirstEvaluation.notes.find(({ id }) => id === AUTOMATION_NOTE_ID)?.body,
    '由受控定时自动化创建。',
  );

  await controller.evaluate();
  await controller.stop();
  assert.equal(
    (await service.getTaskSnapshot({ workspaceId: DEFAULT_WORKSPACE_ID })).tasks.length,
    tasksAfterFirstEvaluation.tasks.length,
  );
  assert.equal(
    (await service.getNoteSnapshot({ workspaceId: DEFAULT_WORKSPACE_ID })).notes.length,
    notesAfterFirstEvaluation.notes.length,
  );

  const weeklyOccurrence = new Date(catchUpNow);
  weeklyOccurrence.setDate(
    weeklyOccurrence.getDate() - ((weeklyOccurrence.getDay() - FIXED_NOW.getDay() + 7) % 7),
  );
  return {
    daily: formatLocalCivilDate(catchUpNow),
    weekly: formatLocalCivilDate(weeklyOccurrence),
  };
}

function createManualAutomationController(
  service: DatabaseService,
  now: () => Date,
): AutomationController {
  return new AutomationController({
    database: service,
    now,
    timer: {
      set: () => Symbol('automation-smoke-timer'),
      clear: () => undefined,
    },
  });
}

function createManualFocusController(service: DatabaseService, now: () => Date): FocusController {
  return new FocusController({
    database: service,
    now,
    timer: {
      set: () => Symbol('focus-smoke-timer'),
      clear: () => undefined,
    },
  });
}

function formatLocalCivilDate(value: Date): string {
  return [
    value.getFullYear().toString().padStart(4, '0'),
    (value.getMonth() + 1).toString().padStart(2, '0'),
    value.getDate().toString().padStart(2, '0'),
  ].join('-');
}

async function smokePortableRoundTrip(
  directory: string,
  source: DatabaseService,
  localBackupPolicy: BackupPolicy,
  expectedSearches: readonly SearchSnapshot[],
  exportedAt: Date,
): Promise<void> {
  await mkdir(directory, { recursive: true });
  const sourceRecords = await source.readPortableRecords();
  const sourceFocusRecords = sourceRecords.filter(({ type }) => type === 'focus-session');
  assert.equal(sourceFocusRecords.length, 1);
  assert.equal(sourceFocusRecords[0]?.data.status, 'completed');
  assert.equal(sourceFocusRecords[0]?.data.remainingSeconds, 0);
  assert.equal(sourceFocusRecords[0]?.data.completedAt, exportedAt.toISOString());
  assert.equal('deadlineAt' in (sourceFocusRecords[0]?.data ?? {}), false);
  assert.equal('cancelledAt' in (sourceFocusRecords[0]?.data ?? {}), false);
  const packageBytes = serializePortablePackage({
    exportId: PORTABLE_EXPORT_ID,
    exportedAt: exportedAt.toISOString(),
    sourceAppVersion: '0.1.0',
    sourceSchemaVersion: 11,
    records: sourceRecords,
  });
  const parsedPackage = parsePortablePackage(packageBytes);
  assert.equal(parsedPackage.manifest.formatVersion, 3);
  assert.equal(parsedPackage.manifest.recordCount, sourceRecords.length);
  assert.equal(parsedPackage.manifest.sourceSchemaVersion, 11);
  assert.equal(parsedPackage.manifest.counts.automations, 2);
  assert.equal(parsedPackage.manifest.counts.enabledAutomations, 2);
  assert.equal(parsedPackage.manifest.counts.focusSessions, 1);
  assert.deepEqual(parsedPackage.records, sourceRecords);
  const pausedRecords = pausePortableAutomationDefinitions(sourceRecords);

  const destinationPath = join(directory, `import-${PORTABLE_IMPORT_ID}.sqlite3`);
  const stager = new AtomicImportStager({
    directory,
    idFactory: () => PORTABLE_STAGING_ID,
    driver: new DatabaseImportStagingDriver({
      localBackupPolicy,
      now: () => FIXED_NOW,
      idFactory: () => PORTABLE_DATABASE_ID,
    }),
  });
  const stagingContext = {
    importId: PORTABLE_IMPORT_ID,
    package: parsedPackage,
    destinationPath,
  };
  await stager.stage(stagingContext);
  await stager.validate(stagingContext);

  let imported: DatabaseService | undefined = new DatabaseService({
    dataDirectory: directory,
    databaseFileName: basename(destinationPath),
    now: () => FIXED_NOW,
    taskTodayFactory: () => FIXED_TODAY,
    scheduleTodayFactory: () => FIXED_TODAY,
    focusTodayFactory: () => FIXED_TODAY,
  });
  try {
    const initialized = await imported.open();
    assert.deepEqual(initialized.migration, {
      fromVersion: 11,
      toVersion: 11,
      applied: [],
    });
    assert.deepEqual(await imported.readPortableRecords(), pausedRecords);
    const importedAutomations = await imported.getAutomationSnapshot({
      workspaceId: DEFAULT_WORKSPACE_ID,
    });
    assert.equal(importedAutomations.items.length, 2);
    assert.equal(
      importedAutomations.items.every(({ enabled }) => !enabled),
      true,
    );
    assert.equal(
      importedAutomations.items.every(({ lastRun }) => lastRun.status === 'never'),
      true,
    );
    const importedFocus = await imported.getFocusSnapshot({ workspaceId: DEFAULT_WORKSPACE_ID });
    assert.equal(importedFocus.session, null);
    assert.equal(importedFocus.todayCompletedCount, 1);
    assert.deepEqual((await imported.getBackupSchedulerState()).policy, localBackupPolicy);
    assert.deepEqual(await imported.getTerminalPreferences(DEFAULT_WORKSPACE_ID), {
      workspaceId: DEFAULT_WORKSPACE_ID,
      preferredProfileId: 'system-default',
      nativeCwdPlatform: null,
      nativeCwdPath: null,
      wslDistributionName: null,
      revision: 1,
      updatedAt: FIXED_NOW.toISOString(),
    });
    for (const expected of expectedSearches) {
      assert.deepEqual(
        await imported.search({
          workspaceId: expected.workspaceId,
          query: expected.query,
          scope: expected.scope,
        }),
        expected,
      );
    }
    const importedArchive = await imported.getWorkspaceArchiveSnapshot();
    assert.equal(importedArchive.archivedWorkspaces.length, 1);
    assert.equal(importedArchive.archivedWorkspaces[0]?.id, SECOND_WORKSPACE_ID);
    assert.equal(importedArchive.archivedWorkspaces[0]?.revision, 2);
    const importedRestore = await imported.restoreWorkspace({
      workspaceId: SECOND_WORKSPACE_ID,
      expectedRevision: importedArchive.archivedWorkspaces[0]?.revision ?? 0,
      name: '便携恢复研发工作区 🧪',
    });
    assert.equal(importedRestore.workspaceSnapshot.currentWorkspaceId, DEFAULT_WORKSPACE_ID);
    assert.deepEqual(importedRestore.archiveSnapshot.archivedWorkspaces, []);
    assert.equal(
      (await imported.getTaskSnapshot({ workspaceId: SECOND_WORKSPACE_ID })).tasks[0]?.id,
      THIRD_TASK_ID,
    );
    assert.equal(
      (await imported.getNoteSnapshot({ workspaceId: SECOND_WORKSPACE_ID })).notes[0]?.id,
      SECOND_NOTE_ID,
    );
    assert.equal(
      (await imported.getScheduleSnapshot({ workspaceId: SECOND_WORKSPACE_ID })).items[0]?.id,
      THIRD_SCHEDULE_ID,
    );
    await imported.close();
    imported = undefined;
  } finally {
    await imported?.close().catch(() => undefined);
  }

  const v2Records = sourceRecords.filter(({ type }) => type !== 'focus-session');
  const legacyRecords = v2Records.filter(({ type }) => type !== 'automation-definition');
  for (const sourceSchemaVersion of [7, 8, 9, 10] as const) {
    const compatibilityRecords =
      sourceSchemaVersion === 10
        ? sourceRecords
        : sourceSchemaVersion === 9
          ? v2Records
          : legacyRecords;
    const legacyDirectory = join(directory, `legacy v${sourceSchemaVersion} package`);
    await mkdir(legacyDirectory, { recursive: true });
    const legacyBytes = serializePortablePackage({
      exportId: PORTABLE_EXPORT_ID,
      exportedAt: FIXED_NOW.toISOString(),
      sourceAppVersion: '0.1.0',
      sourceSchemaVersion,
      records: compatibilityRecords,
    });
    const legacyManifestLine = Buffer.from(legacyBytes)
      .toString('utf8')
      .slice(0, Buffer.from(legacyBytes).indexOf(0x0a));
    const rawLegacyManifest = JSON.parse(legacyManifestLine) as {
      readonly counts: Record<string, unknown>;
    };
    assert.equal('focusSessions' in rawLegacyManifest.counts, sourceSchemaVersion === 10);
    if (sourceSchemaVersion < 9) {
      assert.equal('automations' in rawLegacyManifest.counts, false);
      assert.equal('enabledAutomations' in rawLegacyManifest.counts, false);
    }
    const legacyPackage = parsePortablePackage(legacyBytes);
    assert.equal(
      legacyPackage.manifest.formatVersion,
      sourceSchemaVersion === 10 ? 3 : sourceSchemaVersion === 9 ? 2 : 1,
    );
    assert.equal(legacyPackage.manifest.counts.focusSessions, sourceSchemaVersion === 10 ? 1 : 0);
    assert.equal(legacyPackage.manifest.sourceSchemaVersion, sourceSchemaVersion);
    const legacyDestinationPath = join(legacyDirectory, `import-${PORTABLE_IMPORT_ID}.sqlite3`);
    const legacyStager = new AtomicImportStager({
      directory: legacyDirectory,
      idFactory: () => PORTABLE_STAGING_ID,
      driver: new DatabaseImportStagingDriver({
        localBackupPolicy,
        now: () => FIXED_NOW,
        idFactory: () => PORTABLE_DATABASE_ID,
      }),
    });
    const legacyStagingContext = {
      importId: PORTABLE_IMPORT_ID,
      package: legacyPackage,
      destinationPath: legacyDestinationPath,
    };
    await legacyStager.stage(legacyStagingContext);
    await legacyStager.validate(legacyStagingContext);

    let legacyImported: DatabaseService | undefined = new DatabaseService({
      dataDirectory: legacyDirectory,
      databaseFileName: basename(legacyDestinationPath),
      now: () => FIXED_NOW,
      taskTodayFactory: () => FIXED_TODAY,
      scheduleTodayFactory: () => FIXED_TODAY,
      focusTodayFactory: () => FIXED_TODAY,
    });
    try {
      const initialized = await legacyImported.open();
      assert.deepEqual(initialized.migration, {
        fromVersion: 11,
        toVersion: 11,
        applied: [],
      });
      assert.deepEqual(
        await legacyImported.readPortableRecords(),
        sourceSchemaVersion === 10
          ? pausePortableAutomationDefinitions(sourceRecords)
          : sourceSchemaVersion === 9
            ? pausePortableAutomationDefinitions(v2Records)
            : legacyRecords,
      );
      const compatibilityAutomations = (
        await legacyImported.getAutomationSnapshot({ workspaceId: DEFAULT_WORKSPACE_ID })
      ).items;
      assert.equal(compatibilityAutomations.length, sourceSchemaVersion >= 9 ? 2 : 0);
      assert.equal(
        compatibilityAutomations.every(({ enabled }) => !enabled),
        true,
      );
      const compatibilityFocus = await legacyImported.getFocusSnapshot({
        workspaceId: DEFAULT_WORKSPACE_ID,
      });
      assert.equal(compatibilityFocus.workspaceId, DEFAULT_WORKSPACE_ID);
      assert.equal(compatibilityFocus.todayDate, FIXED_TODAY);
      assert.equal(compatibilityFocus.session, null);
      assert.equal(compatibilityFocus.todayCompletedCount, sourceSchemaVersion === 10 ? 1 : 0);
      assert.equal(
        (await legacyImported.getTerminalPreferences(DEFAULT_WORKSPACE_ID)).preferredProfileId,
        'system-default',
      );
      await legacyImported.close();
      legacyImported = undefined;
    } finally {
      await legacyImported?.close().catch(() => undefined);
    }
  }
}

function pausePortableAutomationDefinitions(
  records: readonly PortableDataRecord[],
): readonly PortableDataRecord[] {
  return records.map((record) =>
    record.type === 'automation-definition'
      ? {
          ...record,
          data: {
            ...record.data,
            enabled: false,
          },
        }
      : record,
  );
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
    assert.equal(upgraded.migration.toVersion, 11);
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
  }).initialize(database, undefined, false);
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
    assert.equal(upgraded.migration.toVersion, 11);
    assert.equal(upgraded.preMigrationBackup?.schemaVersion, 2);
    assert.deepEqual(
      (await service.getInboxSnapshot({ workspaceId: DEFAULT_WORKSPACE_ID })).entries,
      [],
    );
    await service.createInboxEntry({
      workspaceId: DEFAULT_WORKSPACE_ID,
      content: 'v2 → v7 打包升级',
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
  }).initialize(database, undefined, false);
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
    assert.equal(upgraded.migration.toVersion, 11);
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
      planning: 'day-0',
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
  }).initialize(database, undefined, false);
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
    planning: 'day-0',
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
    assert.equal(upgraded.migration.toVersion, 11);
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
      title: 'v4 → v7 新增的今日日程',
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
    assert.deepEqual(reopened.migration, { fromVersion: 11, toVersion: 11, applied: [] });
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
  }).initialize(database, undefined, false);
  await new NoteService({
    execute: executeLegacy,
    now: () => FIXED_NOW,
    idFactory: () => FIRST_NOTE_ID,
  }).create({
    workspaceId: DEFAULT_WORKSPACE_ID,
    title: 'v5 必须保留的 Markdown 笔记',
    body: '# v5 → v7',
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
    assert.equal(upgraded.migration.toVersion, 11);
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

async function smokeVersionSixUpgrade(dataDirectory: string): Promise<void> {
  await mkdir(dataDirectory, { recursive: true });
  const databasePath = join(dataDirectory, 'daily-workbench.sqlite3');
  const database = createNodeSqliteAdapter(databasePath);
  database.open();
  configureDesktopPragmas(database);
  new MigrationRunner(DEFAULT_MIGRATIONS.slice(0, 6)).apply(database);
  new MetadataRepository(database).initialize(
    FIXED_NOW.toISOString(),
    '30303030-3030-4030-8030-303030303030',
  );
  const executeLegacy = async <T>(
    operation: (adapter: typeof database) => Promise<T> | T,
  ): Promise<T> => await operation(database);
  new WorkspaceService({
    execute: executeLegacy,
    now: () => FIXED_NOW,
    idFactory: () => DEFAULT_WORKSPACE_ID,
  }).initialize(database, undefined, false);
  await new NoteService({
    execute: executeLegacy,
    now: () => FIXED_NOW,
    idFactory: () => FIRST_NOTE_ID,
  }).create({
    workspaceId: DEFAULT_WORKSPACE_ID,
    title: 'v6 必须进入全文索引的笔记',
    body: '# v6 → v7 搜索索引回填',
  });
  const legacyBrowser = new BrowserService({
    execute: executeLegacy,
    now: () => FIXED_NOW,
    tabIdFactory: () => FIRST_BROWSER_TAB_ID,
    bookmarkIdFactory: () => FIRST_BROWSER_BOOKMARK_ID,
  });
  let browser = await legacyBrowser.getData({ workspaceId: DEFAULT_WORKSPACE_ID });
  browser = await legacyBrowser.persistTabMetadata({
    workspaceId: DEFAULT_WORKSPACE_ID,
    tabId: browser.activeTabId,
    url: 'https://example.com/v6-to-v7',
    title: 'v6 浏览器数据',
  });
  await legacyBrowser.toggleBookmark({
    workspaceId: DEFAULT_WORKSPACE_ID,
    tabId: browser.activeTabId,
  });
  database.close();

  let service: DatabaseService | undefined = new DatabaseService({
    dataDirectory,
    now: () => FIXED_NOW,
    taskTodayFactory: () => FIXED_TODAY,
    scheduleTodayFactory: () => FIXED_TODAY,
  });
  try {
    const upgraded = await service.open();
    assert.equal(upgraded.migration.fromVersion, 6);
    assert.equal(upgraded.migration.toVersion, 11);
    assert.equal(upgraded.preMigrationBackup?.schemaVersion, 6);
    assert.equal(
      (await service.getNoteSnapshot({ workspaceId: DEFAULT_WORKSPACE_ID })).notes[0]?.id,
      FIRST_NOTE_ID,
    );
    browser = await service.getBrowserData({ workspaceId: DEFAULT_WORKSPACE_ID });
    assert.equal(browser.tabs[0]?.url, 'https://example.com/v6-to-v7');
    assert.equal(browser.bookmarks[0]?.id, FIRST_BROWSER_BOOKMARK_ID);

    const backup = upgraded.preMigrationBackup;
    assert.ok(backup);
    const legacySnapshot = new DatabaseSync(join(dataDirectory, 'backups', backup.fileName), {
      readOnly: true,
    });
    try {
      assert.equal(legacySnapshot.prepare('PRAGMA user_version').get()?.user_version, 6);
      assert.equal(legacySnapshot.prepare('SELECT COUNT(*) AS count FROM notes').get()?.count, 1);
      assert.equal(
        legacySnapshot.prepare('SELECT COUNT(*) AS count FROM browser_tabs').get()?.count,
        1,
      );
      assert.equal(
        legacySnapshot
          .prepare("SELECT COUNT(*) AS count FROM sqlite_schema WHERE name = 'notes_search'")
          .get()?.count,
        0,
      );
    } finally {
      legacySnapshot.close();
    }

    await service.close();
    service = undefined;
    const upgradedSnapshot = new DatabaseSync(databasePath, { readOnly: true });
    try {
      assert.equal(upgradedSnapshot.prepare('PRAGMA user_version').get()?.user_version, 11);
      assert.equal(
        upgradedSnapshot
          .prepare("SELECT COUNT(*) AS count FROM notes_search WHERE notes_search MATCH '搜索索引'")
          .get()?.count,
        1,
      );
      assert.equal(
        upgradedSnapshot
          .prepare(
            "SELECT COUNT(*) AS count FROM browser_bookmarks_search WHERE browser_bookmarks_search MATCH '浏览器'",
          )
          .get()?.count,
        1,
      );
    } finally {
      upgradedSnapshot.close();
    }
  } finally {
    await service?.close().catch(() => undefined);
  }
}

async function smokeVersionSevenUpgrade(dataDirectory: string): Promise<void> {
  let legacy: DatabaseService | undefined = new DatabaseService({
    dataDirectory,
    migrations: DEFAULT_MIGRATIONS.slice(0, 7),
    now: () => FIXED_NOW,
    workspaceIdFactory: () => DEFAULT_WORKSPACE_ID,
    noteIdFactory: () => FIRST_NOTE_ID,
    taskTodayFactory: () => FIXED_TODAY,
    scheduleTodayFactory: () => FIXED_TODAY,
    browserTabIdFactory: () => FIRST_BROWSER_TAB_ID,
  });
  try {
    const initialized = await legacy.open();
    assert.equal(initialized.migration.toVersion, 7);
    await legacy.createNote({
      workspaceId: DEFAULT_WORKSPACE_ID,
      title: 'v7 → v8 终端偏好回填',
      body: '既有业务数据必须保留。',
    });
    await legacy.close();
    legacy = undefined;
  } finally {
    await legacy?.close().catch(() => undefined);
  }

  let upgradedService: DatabaseService | undefined = new DatabaseService({
    dataDirectory,
    now: () => FIXED_NOW,
    taskTodayFactory: () => FIXED_TODAY,
    scheduleTodayFactory: () => FIXED_TODAY,
  });
  try {
    const upgraded = await upgradedService.open();
    assert.equal(upgraded.migration.fromVersion, 7);
    assert.equal(upgraded.migration.toVersion, 11);
    assert.equal(upgraded.preMigrationBackup?.schemaVersion, 7);
    assert.equal(
      (await upgradedService.getNoteSnapshot({ workspaceId: DEFAULT_WORKSPACE_ID })).notes[0]
        ?.title,
      'v7 → v8 终端偏好回填',
    );
    assert.deepEqual(await upgradedService.getTerminalPreferences(DEFAULT_WORKSPACE_ID), {
      workspaceId: DEFAULT_WORKSPACE_ID,
      preferredProfileId: 'system-default',
      nativeCwdPlatform: null,
      nativeCwdPath: null,
      wslDistributionName: null,
      revision: 1,
      updatedAt: FIXED_NOW.toISOString(),
    });

    const backup = upgraded.preMigrationBackup;
    assert.ok(backup);
    const legacySnapshot = new DatabaseSync(join(dataDirectory, 'backups', backup.fileName), {
      readOnly: true,
    });
    try {
      assert.equal(legacySnapshot.prepare('PRAGMA user_version').get()?.user_version, 7);
      assert.equal(
        legacySnapshot
          .prepare(
            "SELECT COUNT(*) AS count FROM sqlite_schema WHERE name = 'workspace_terminal_preferences'",
          )
          .get()?.count,
        0,
      );
    } finally {
      legacySnapshot.close();
    }

    await upgradedService.close();
    upgradedService = undefined;
    const upgradedSnapshot = new DatabaseSync(join(dataDirectory, 'daily-workbench.sqlite3'), {
      readOnly: true,
    });
    try {
      assert.equal(upgradedSnapshot.prepare('PRAGMA user_version').get()?.user_version, 11);
      assert.equal(
        upgradedSnapshot
          .prepare('SELECT COUNT(*) AS count FROM workspace_terminal_preferences')
          .get()?.count,
        1,
      );
    } finally {
      upgradedSnapshot.close();
    }
  } finally {
    await upgradedService?.close().catch(() => undefined);
  }
}

async function smokeVersionEightUpgrade(dataDirectory: string): Promise<void> {
  let legacy: DatabaseService | undefined = new DatabaseService({
    dataDirectory,
    migrations: DEFAULT_MIGRATIONS.slice(0, 8),
    now: () => FIXED_NOW,
    workspaceIdFactory: () => DEFAULT_WORKSPACE_ID,
    taskTodayFactory: () => FIXED_TODAY,
    scheduleTodayFactory: () => FIXED_TODAY,
    browserTabIdFactory: () => FIRST_BROWSER_TAB_ID,
  });
  try {
    const initialized = await legacy.open();
    assert.equal(initialized.migration.toVersion, 8);
    let preferences = await legacy.getTerminalPreferences(DEFAULT_WORKSPACE_ID);
    preferences = await legacy.updateTerminalProfilePreference({
      workspaceId: DEFAULT_WORKSPACE_ID,
      preferredProfileId: 'bash',
      expectedRevision: preferences.revision,
    });
    assert.equal(preferences.revision, 2);
    await legacy.close();
    legacy = undefined;
  } finally {
    await legacy?.close().catch(() => undefined);
  }

  const upgradedService = new DatabaseService({
    dataDirectory,
    now: () => FIXED_NOW,
    taskTodayFactory: () => FIXED_TODAY,
    scheduleTodayFactory: () => FIXED_TODAY,
  });
  try {
    const upgraded = await upgradedService.open();
    assert.equal(upgraded.migration.fromVersion, 8);
    assert.equal(upgraded.migration.toVersion, 11);
    assert.equal(upgraded.preMigrationBackup?.schemaVersion, 8);
    assert.equal(
      (await upgradedService.getTerminalPreferences(DEFAULT_WORKSPACE_ID)).preferredProfileId,
      'bash',
    );
    assert.deepEqual(
      (await upgradedService.getAutomationSnapshot({ workspaceId: DEFAULT_WORKSPACE_ID })).items,
      [],
    );

    const backup = upgraded.preMigrationBackup;
    assert.ok(backup);
    const legacySnapshot = new DatabaseSync(join(dataDirectory, 'backups', backup.fileName), {
      readOnly: true,
    });
    try {
      assert.equal(legacySnapshot.prepare('PRAGMA user_version').get()?.user_version, 8);
      assert.equal(
        legacySnapshot
          .prepare("SELECT COUNT(*) AS count FROM sqlite_schema WHERE name = 'automations'")
          .get()?.count,
        0,
      );
      assert.equal(
        legacySnapshot
          .prepare('SELECT preferred_profile_id FROM workspace_terminal_preferences')
          .get()?.preferred_profile_id,
        'bash',
      );
    } finally {
      legacySnapshot.close();
    }
  } finally {
    await upgradedService.close().catch(() => undefined);
  }
}

async function smokeVersionNineUpgrade(dataDirectory: string): Promise<void> {
  let legacy: DatabaseService | undefined = new DatabaseService({
    dataDirectory,
    migrations: DEFAULT_MIGRATIONS.slice(0, 9),
    now: () => FIXED_NOW,
    workspaceIdFactory: () => DEFAULT_WORKSPACE_ID,
    taskIdFactory: () => FIRST_TASK_ID,
    taskTodayFactory: () => FIXED_TODAY,
    scheduleTodayFactory: () => FIXED_TODAY,
    browserTabIdFactory: () => FIRST_BROWSER_TAB_ID,
  });
  try {
    const initialized = await legacy.open();
    assert.equal(initialized.migration.toVersion, 9);
    await legacy.createTask({
      workspaceId: DEFAULT_WORKSPACE_ID,
      title: 'v9 → v10 专注迁移保留任务',
      planning: 'day-0',
    });
    await legacy.close();
    legacy = undefined;
  } finally {
    await legacy?.close().catch(() => undefined);
  }

  let upgradedService: DatabaseService | undefined = new DatabaseService({
    dataDirectory,
    now: () => FIXED_NOW,
    taskTodayFactory: () => FIXED_TODAY,
    scheduleTodayFactory: () => FIXED_TODAY,
  });
  try {
    const upgraded = await upgradedService.open();
    assert.equal(upgraded.migration.fromVersion, 9);
    assert.equal(upgraded.migration.toVersion, 11);
    assert.equal(upgraded.preMigrationBackup?.schemaVersion, 9);
    assert.equal(
      (await upgradedService.getTaskSnapshot({ workspaceId: DEFAULT_WORKSPACE_ID })).tasks[0]
        ?.title,
      'v9 → v10 专注迁移保留任务',
    );

    const backup = upgraded.preMigrationBackup;
    assert.ok(backup);
    const legacySnapshot = new DatabaseSync(join(dataDirectory, 'backups', backup.fileName), {
      readOnly: true,
    });
    try {
      assert.equal(legacySnapshot.prepare('PRAGMA user_version').get()?.user_version, 9);
      assert.equal(
        legacySnapshot
          .prepare("SELECT COUNT(*) AS count FROM sqlite_schema WHERE name = 'focus_sessions'")
          .get()?.count,
        0,
      );
    } finally {
      legacySnapshot.close();
    }

    await upgradedService.close();
    upgradedService = undefined;
    const upgradedSnapshot = new DatabaseSync(join(dataDirectory, 'daily-workbench.sqlite3'), {
      readOnly: true,
    });
    try {
      assert.equal(upgradedSnapshot.prepare('PRAGMA user_version').get()?.user_version, 11);
      assert.equal(
        upgradedSnapshot.prepare('SELECT COUNT(*) AS count FROM focus_sessions').get()?.count,
        0,
      );
    } finally {
      upgradedSnapshot.close();
    }
  } finally {
    await upgradedService?.close().catch(() => undefined);
  }
}

async function smokeVersionTenUpgrade(dataDirectory: string): Promise<void> {
  const workspaceIds = [DEFAULT_WORKSPACE_ID, SECOND_WORKSPACE_ID];
  let legacy: DatabaseService | undefined = new DatabaseService({
    dataDirectory,
    migrations: DEFAULT_MIGRATIONS.slice(0, 10),
    now: () => FIXED_NOW,
    workspaceIdFactory: () => workspaceIds.shift() ?? '41414141-4141-4141-8141-414141414141',
    taskTodayFactory: () => FIXED_TODAY,
    scheduleTodayFactory: () => FIXED_TODAY,
    browserTabIdFactory: () => FIRST_BROWSER_TAB_ID,
    focusTodayFactory: () => FIXED_TODAY,
  });
  try {
    const initialized = await legacy.open();
    assert.equal(initialized.migration.toVersion, 10);
    let snapshot = await legacy.createWorkspace({
      name: 'v10 归档工作区',
      color: WORKSPACE_COLORS[4],
    });
    assert.equal(snapshot.currentWorkspaceId, SECOND_WORKSPACE_ID);
    snapshot = await legacy.activateWorkspace({ workspaceId: DEFAULT_WORKSPACE_ID });
    assert.equal(snapshot.currentWorkspaceId, DEFAULT_WORKSPACE_ID);
    snapshot = await legacy.archiveWorkspace({ workspaceId: SECOND_WORKSPACE_ID });
    assert.deepEqual(
      snapshot.workspaces.map(({ id }) => id),
      [DEFAULT_WORKSPACE_ID],
    );
    await legacy.close();
    legacy = undefined;
  } finally {
    await legacy?.close().catch(() => undefined);
  }

  let upgradedService: DatabaseService | undefined = new DatabaseService({
    dataDirectory,
    now: () => FIXED_NOW,
    taskTodayFactory: () => FIXED_TODAY,
    scheduleTodayFactory: () => FIXED_TODAY,
    focusTodayFactory: () => FIXED_TODAY,
  });
  try {
    const upgraded = await upgradedService.open();
    assert.equal(upgraded.migration.fromVersion, 10);
    assert.equal(upgraded.migration.toVersion, 11);
    assert.deepEqual(
      upgraded.migration.applied.map(({ version }) => version),
      [11],
    );
    assert.equal(upgraded.preMigrationBackup?.schemaVersion, 10);

    let archiveSnapshot = await upgradedService.getWorkspaceArchiveSnapshot();
    assert.deepEqual(
      archiveSnapshot.archivedWorkspaces.map(({ id, name, revision }) => ({
        id,
        name,
        revision,
      })),
      [{ id: SECOND_WORKSPACE_ID, name: 'v10 归档工作区', revision: 2 }],
    );
    const restored = await upgradedService.restoreWorkspace({
      workspaceId: SECOND_WORKSPACE_ID,
      expectedRevision: 2,
      name: 'v11 恢复工作区',
    });
    assert.equal(restored.workspaceSnapshot.currentWorkspaceId, DEFAULT_WORKSPACE_ID);
    assert.deepEqual(restored.archiveSnapshot.archivedWorkspaces, []);

    await upgradedService.archiveWorkspace({ workspaceId: SECOND_WORKSPACE_ID });
    archiveSnapshot = await upgradedService.getWorkspaceArchiveSnapshot();
    assert.equal(archiveSnapshot.archivedWorkspaces[0]?.revision, 4);
    await assert.rejects(
      upgradedService.restoreWorkspace({
        workspaceId: SECOND_WORKSPACE_ID,
        expectedRevision: 2,
        name: '旧请求不能重放',
      }),
      {
        name: 'WorkspaceConflictError',
        message: 'The archived workspace changed. Reload and retry.',
      },
    );

    const backup = upgraded.preMigrationBackup;
    assert.ok(backup);
    const legacySnapshot = new DatabaseSync(join(dataDirectory, 'backups', backup.fileName), {
      readOnly: true,
    });
    try {
      assert.equal(legacySnapshot.prepare('PRAGMA user_version').get()?.user_version, 10);
      assert.equal(
        legacySnapshot
          .prepare(
            "SELECT COUNT(*) AS count FROM sqlite_schema WHERE name = 'workspace_recovery_revisions'",
          )
          .get()?.count,
        0,
      );
    } finally {
      legacySnapshot.close();
    }

    await upgradedService.close();
    upgradedService = undefined;
    const upgradedSnapshot = new DatabaseSync(join(dataDirectory, 'daily-workbench.sqlite3'), {
      readOnly: true,
    });
    try {
      assert.equal(upgradedSnapshot.prepare('PRAGMA user_version').get()?.user_version, 11);
      assert.equal(
        upgradedSnapshot.prepare('SELECT COUNT(*) AS count FROM workspace_recovery_revisions').get()
          ?.count,
        2,
      );
      assert.equal(
        upgradedSnapshot
          .prepare('SELECT revision FROM workspace_recovery_revisions WHERE workspace_id = ?')
          .get(SECOND_WORKSPACE_ID)?.revision,
        4,
      );
    } finally {
      upgradedSnapshot.close();
    }
  } finally {
    await upgradedService?.close().catch(() => undefined);
  }
}

async function smokeBackupPointInTimeRestore(dataDirectory: string): Promise<void> {
  await mkdir(dataDirectory, { recursive: true });
  let serviceNow = new Date(FIXED_NOW);
  let legacyBackup: Awaited<ReturnType<DatabaseService['createBackup']>> | undefined;
  let legacy: DatabaseService | undefined = new DatabaseService({
    dataDirectory,
    migrations: DEFAULT_MIGRATIONS.slice(0, 10),
    now: () => serviceNow,
    workspaceIdFactory: () => DEFAULT_WORKSPACE_ID,
    taskIdFactory: () => BACKUP_RESTORE_TASK_ID,
    taskTodayFactory: () => FIXED_TODAY,
    scheduleTodayFactory: () => FIXED_TODAY,
    automationIdFactory: () => BACKUP_RESTORE_AUTOMATION_ID,
    focusIdFactory: () => BACKUP_RESTORE_FOCUS_ID,
    focusTodayFactory: () => FIXED_TODAY,
    browserTabIdFactory: () => FIRST_BROWSER_TAB_ID,
  });
  try {
    const initialized = await legacy.open();
    assert.equal(initialized.migration.toVersion, 10);
    await legacy.updateWorkspacePreferences({
      workspaceId: DEFAULT_WORKSPACE_ID,
      patch: {
        activeView: 'tasks',
        browserOpen: true,
        terminalOpen: true,
      },
    });
    await legacy.createTask({
      workspaceId: DEFAULT_WORKSPACE_ID,
      title: '来自 v10 备份的恢复目标',
      planning: 'day-0',
    });
    let automations = await legacy.createAutomation({
      workspaceId: DEFAULT_WORKSPACE_ID,
      name: '恢复后必须停用的自动化',
      schedule: {
        cadence: 'daily',
        localTimeMinute: 9 * 60,
        weekday: null,
      },
      action: {
        kind: 'create-note',
        title: '恢复 smoke 自动化',
        body: '不得在数据库恢复后自行运行。',
      },
    });
    const automation = automations.items.find(({ id }) => id === BACKUP_RESTORE_AUTOMATION_ID);
    assert.ok(automation);
    automations = await legacy.setAutomationEnabled({
      workspaceId: DEFAULT_WORKSPACE_ID,
      automationId: automation.id,
      expectedRevision: automation.revision,
      enabled: true,
    });
    assert.equal(
      automations.items.find(({ id }) => id === BACKUP_RESTORE_AUTOMATION_ID)?.enabled,
      true,
    );
    const focus = await legacy.startFocusSession({
      workspaceId: DEFAULT_WORKSPACE_ID,
    });
    assert.equal(focus.session?.id, BACKUP_RESTORE_FOCUS_ID);
    assert.equal(focus.session?.status, 'running');

    legacyBackup = await legacy.createBackup();
    assert.equal(legacyBackup.schemaVersion, 10);
    assert.equal(legacyBackup.reason, 'manual');
    await legacy.close();
    legacy = undefined;
  } finally {
    await legacy?.close().catch(() => undefined);
  }

  assert.ok(legacyBackup);
  const sourceBackupPath = join(dataDirectory, 'backups', legacyBackup.fileName);
  const sourceDigest = await sha256File(sourceBackupPath);
  const restoreInput = {
    backupId: legacyBackup.id,
    expectedReason: legacyBackup.reason,
    expectedCreatedAt: legacyBackup.createdAt,
    expectedSizeBytes: legacyBackup.sizeBytes,
    expectedSchemaVersion: legacyBackup.schemaVersion,
  } as const;

  serviceNow = new Date(FIXED_NOW.getTime() + 5 * 60_000);
  let current: DatabaseService | undefined = new DatabaseService({
    dataDirectory,
    now: () => serviceNow,
    taskIdFactory: () => BACKUP_RESTORE_POST_TASK_ID,
    taskTodayFactory: () => FIXED_TODAY,
    scheduleTodayFactory: () => FIXED_TODAY,
    focusTodayFactory: () => FIXED_TODAY,
  });
  let committedStaging: Awaited<ReturnType<DatabaseService['prepareBackupRestore']>> | undefined;
  let safetyBackup: Awaited<ReturnType<DatabaseService['createPreImportBackup']>> | undefined;
  let currentBackupState:
    Awaited<ReturnType<DatabaseService['getBackupSchedulerState']>> | undefined;
  try {
    const upgraded = await current.open();
    assert.equal(upgraded.migration.fromVersion, 10);
    assert.equal(upgraded.migration.toVersion, 11);
    await current.createTask({
      workspaceId: DEFAULT_WORKSPACE_ID,
      title: '恢复后不应保留的较新任务',
      planning: 'none',
    });

    const initialBackupState = await current.getBackupSchedulerState();
    await current.updateBackupPolicy({
      enabled: true,
      cadence: 'weekly',
      localTimeMinute: 8 * 60 + 45,
      weekday: 5,
      retentionCount: 23,
      expectedRevision: initialBackupState.policy.revision,
    });
    const attemptedAt = new Date(serviceNow.getTime() + 1_000).toISOString();
    const completedAt = new Date(serviceNow.getTime() + 2_000).toISOString();
    await current.recordBackupAttempt(attemptedAt);
    await current.recordBackupResult({
      attemptedAt,
      completedAt,
      successfulBucket: 'weekly:2026-07-17',
    });
    currentBackupState = await current.getBackupSchedulerState();
    assert.equal(currentBackupState.policy.cadence, 'weekly');
    assert.equal(currentBackupState.lastSuccessBucket, 'weekly:2026-07-17');

    const pausedStaging = await current.prepareBackupRestore(
      restoreInput,
      BACKUP_RESTORE_PAUSED_ID,
    );
    assert.deepEqual(pausedStaging.backup, legacyBackup);
    assert.equal(pausedStaging.sourceDigest, sourceDigest);
    assertPreparedBackupRestore(
      join(dataDirectory, 'imports', pausedStaging.stagingFileName),
      'paused',
      currentBackupState,
    );
    assert.equal(await sha256File(sourceBackupPath), sourceDigest);
    await current.discardBackupRestore(pausedStaging);

    serviceNow = new Date(FIXED_NOW.getTime() + 30 * 60_000);
    committedStaging = await current.prepareBackupRestore(
      restoreInput,
      BACKUP_RESTORE_COMMITTED_ID,
    );
    assert.equal(committedStaging.sourceDigest, sourceDigest);
    assertPreparedBackupRestore(
      join(dataDirectory, 'imports', committedStaging.stagingFileName),
      'completed',
      currentBackupState,
    );
    assert.equal(await sha256File(sourceBackupPath), sourceDigest);

    committedStaging = await current.refreshBackupRestore(committedStaging);
    assert.equal(committedStaging.sourceDigest, sourceDigest);
    assertPreparedBackupRestore(
      join(dataDirectory, 'imports', committedStaging.stagingFileName),
      'completed',
      currentBackupState,
    );
    safetyBackup = await current.createPreImportBackup();
    assert.equal(safetyBackup.reason, 'pre-import');
    assert.deepEqual(
      await current.validateExistingBackup(safetyBackup.id, 'pre-import'),
      safetyBackup,
    );

    await current.close();
    current = undefined;
  } finally {
    await current?.close().catch(() => undefined);
  }

  assert.ok(committedStaging);
  assert.ok(safetyBackup);
  assert.ok(currentBackupState);
  const markerStore = new ReplacementMarkerStore(
    new FileReplacementMarkerPersistence({ dataDirectory }),
  );
  await markerStore.create({
    replacementId: committedStaging.restoreId,
    timestamp: serviceNow.toISOString(),
    databaseFileName: 'daily-workbench.sqlite3',
    stagingFileName: committedStaging.stagingFileName,
    rollbackFileName: `rollback-${committedStaging.restoreId}.sqlite3`,
    stagingSha256: committedStaging.stagingDigest,
    preImportBackupId: safetyBackup.id,
  });
  const recovery = new DatabaseReplacementRecovery({
    dataDirectory,
    markerStore,
    checkpointCurrentDatabase: async () => {
      let checkpoint: DatabaseService | undefined = new DatabaseService({
        dataDirectory,
        now: () => serviceNow,
        taskTodayFactory: () => FIXED_TODAY,
        scheduleTodayFactory: () => FIXED_TODAY,
        focusTodayFactory: () => FIXED_TODAY,
      });
      try {
        await checkpoint.open();
        await checkpoint.close();
        checkpoint = undefined;
      } finally {
        await checkpoint?.close().catch(() => undefined);
      }
    },
    validateInstalledDatabase: () =>
      new DatabaseService({ dataDirectory, now: () => serviceNow }).validateExistingFile(),
    validatePreImportBackup: async (backupId) => {
      const validated = await new DatabaseService({
        dataDirectory,
        now: () => serviceNow,
      }).validateExistingBackup(backupId, 'pre-import');
      assert.equal(validated.id, safetyBackup?.id);
    },
    validateRecoveryDatabase: (fileName) =>
      new DatabaseService({
        dataDirectory,
        databaseFileName: fileName,
        now: () => serviceNow,
      }).validateExistingFile(),
    now: () => serviceNow,
  });
  assert.deepEqual(await recovery.recover(), {
    outcome: 'committed',
    preImportBackupId: safetyBackup.id,
  });
  assert.equal(await sha256File(sourceBackupPath), sourceDigest);

  let restored: DatabaseService | undefined = new DatabaseService({
    dataDirectory,
    now: () => serviceNow,
    taskTodayFactory: () => FIXED_TODAY,
    scheduleTodayFactory: () => FIXED_TODAY,
    focusTodayFactory: () => FIXED_TODAY,
  });
  try {
    const reopened = await restored.open();
    assert.deepEqual(reopened.migration, {
      fromVersion: 11,
      toVersion: 11,
      applied: [],
    });
    const tasks = await restored.getTaskSnapshot({ workspaceId: DEFAULT_WORKSPACE_ID });
    assert.equal(
      tasks.tasks.find(({ id }) => id === BACKUP_RESTORE_TASK_ID)?.title,
      '来自 v10 备份的恢复目标',
    );
    assert.equal(
      tasks.tasks.some(({ id }) => id === BACKUP_RESTORE_POST_TASK_ID),
      false,
    );
    const workspace = await restored.getWorkspaceSnapshot();
    assert.equal(workspace.preferences.browserOpen, false);
    assert.equal(workspace.preferences.terminalOpen, false);
    const automations = await restored.getAutomationSnapshot({
      workspaceId: DEFAULT_WORKSPACE_ID,
    });
    assert.equal(automations.items.length, 1);
    assert.equal(automations.items[0]?.enabled, false);
    assert.deepEqual(await restored.getBackupSchedulerState(), currentBackupState);
    assert.equal(
      (await restored.listBackups()).some(({ id }) => id === legacyBackup.id),
      true,
    );
    assert.deepEqual(
      await restored.validateExistingBackup(safetyBackup.id, 'pre-import'),
      safetyBackup,
    );
    await restored.close();
    restored = undefined;
  } finally {
    await restored?.close().catch(() => undefined);
  }

  const installed = new DatabaseSync(join(dataDirectory, 'daily-workbench.sqlite3'), {
    readOnly: true,
  });
  try {
    assert.equal(installed.prepare('PRAGMA user_version').get()?.user_version, 11);
    const focus = installed
      .prepare(
        `SELECT state, remaining_seconds AS remainingSeconds,
                deadline_at AS deadlineAt, completed_at AS completedAt
         FROM focus_sessions
         WHERE id = ?`,
      )
      .get(BACKUP_RESTORE_FOCUS_ID);
    assert.equal(focus?.state, 'completed');
    assert.equal(focus?.remainingSeconds, 0);
    assert.equal(focus?.deadlineAt, null);
    assert.equal(focus?.completedAt, serviceNow.toISOString());
  } finally {
    installed.close();
  }
}

function assertPreparedBackupRestore(
  path: string,
  expectedFocusState: 'paused' | 'completed',
  expectedBackupState: Awaited<ReturnType<DatabaseService['getBackupSchedulerState']>>,
): void {
  const staging = new DatabaseSync(path, { readOnly: true });
  try {
    assert.equal(staging.prepare('PRAGMA user_version').get()?.user_version, 11);
    assert.equal(staging.prepare('PRAGMA quick_check').get()?.quick_check, 'ok');
    assert.equal(
      staging.prepare('SELECT title FROM tasks WHERE id = ?').get(BACKUP_RESTORE_TASK_ID)?.title,
      '来自 v10 备份的恢复目标',
    );
    assert.equal(
      staging
        .prepare(
          'SELECT COUNT(*) AS count FROM automations WHERE enabled = 1 OR effective_at IS NOT NULL',
        )
        .get()?.count,
      0,
    );
    assert.equal(
      staging
        .prepare(
          `SELECT COUNT(*) AS count
           FROM workspace_preferences
           WHERE browser_open = 1 OR terminal_open = 1`,
        )
        .get()?.count,
      0,
    );

    const focus = staging
      .prepare(
        `SELECT state, remaining_seconds AS remainingSeconds,
                deadline_at AS deadlineAt, completed_at AS completedAt
         FROM focus_sessions
         WHERE id = ?`,
      )
      .get(BACKUP_RESTORE_FOCUS_ID);
    assert.equal(focus?.state, expectedFocusState);
    assert.equal(focus?.remainingSeconds, expectedFocusState === 'paused' ? 20 * 60 : 0);
    assert.equal(focus?.deadlineAt, null);
    assert.equal(
      focus?.completedAt,
      expectedFocusState === 'completed'
        ? new Date(FIXED_NOW.getTime() + 30 * 60_000).toISOString()
        : null,
    );

    const policy = staging
      .prepare(
        `SELECT enabled, cadence, local_time_minute AS localTimeMinute,
                weekday, retention_count AS retentionCount, revision,
                updated_at AS updatedAt
         FROM backup_policy
         WHERE singleton = 1`,
      )
      .get();
    assert.deepEqual(
      policy
        ? {
            ...policy,
            enabled: policy.enabled === 1,
          }
        : undefined,
      expectedBackupState.policy,
    );
    const runState = staging
      .prepare(
        `SELECT last_attempt_at AS lastAttemptAt, last_success_at AS lastSuccessAt,
                last_success_bucket AS lastSuccessBucket, last_error_code AS lastErrorCode,
                consecutive_failures AS consecutiveFailures
         FROM backup_run_state
         WHERE singleton = 1`,
      )
      .get();
    assert.deepEqual(runState ? { ...runState } : undefined, {
      lastAttemptAt: expectedBackupState.lastAttemptAt,
      lastSuccessAt: expectedBackupState.lastSuccessAt,
      lastSuccessBucket: expectedBackupState.lastSuccessBucket,
      lastErrorCode: expectedBackupState.lastErrorCode,
      consecutiveFailures: expectedBackupState.consecutiveFailures,
    });
  } finally {
    staging.close();
  }
}

async function sha256File(path: string): Promise<string> {
  return createHash('sha256')
    .update(await readFile(path))
    .digest('hex');
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
