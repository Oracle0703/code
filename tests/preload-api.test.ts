import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkbenchApi } from '../src/shared/contracts';

const electron = vi.hoisted(() => ({
  exposeInMainWorld: vi.fn(),
  invoke: vi.fn(() => Promise.resolve(undefined)),
  on: vi.fn(),
  removeListener: vi.fn(),
}));

vi.mock('electron', () => ({
  contextBridge: { exposeInMainWorld: electron.exposeInMainWorld },
  ipcRenderer: {
    invoke: electron.invoke,
    on: electron.on,
    removeListener: electron.removeListener,
  },
}));

let api: WorkbenchApi;

beforeAll(async () => {
  await import('../src/preload/index');
  expect(electron.exposeInMainWorld).toHaveBeenCalledTimes(1);
  api = electron.exposeInMainWorld.mock.calls[0]?.[1] as WorkbenchApi;
});

beforeEach(() => {
  electron.invoke.mockClear();
  electron.on.mockClear();
  electron.removeListener.mockClear();
});

afterEach(() => {
  vi.unstubAllGlobals();
  electron.invoke.mockImplementation(() => Promise.resolve(undefined));
});

describe('preload data and search API', () => {
  it('exposes only the declared frozen data and search methods', () => {
    expect(Object.keys(api.database).sort()).toEqual([
      'cancelImport',
      'chooseImport',
      'commitImport',
      'createBackup',
      'exportData',
      'getManagementSnapshot',
      'getStatus',
      'listBackups',
      'onBackupStateChange',
      'updateBackupPolicy',
    ]);
    expect(Object.keys(api.search)).toEqual(['query']);
    expect(Object.isFrozen(api.database)).toBe(true);
    expect(Object.isFrozen(api.search)).toBe(true);
  });

  it('forwards exact data-management and search inputs through allowlisted channels', async () => {
    const importId = '123e4567-e89b-42d3-a456-426614174000';
    const policy = {
      enabled: true,
      cadence: 'weekly' as const,
      localTimeMinute: 180,
      weekday: 4,
      retentionCount: 21,
      expectedRevision: 2,
    };
    const search = {
      workspaceId: '223e4567-e89b-42d3-a456-426614174000',
      query: '项目 搜索',
      scope: 'all' as const,
    };

    await api.database.getManagementSnapshot();
    await api.database.updateBackupPolicy(policy);
    await api.database.exportData();
    await api.database.chooseImport();
    await api.database.commitImport({ importId, previewDigest: 'a'.repeat(64) });
    await api.database.cancelImport({ importId });
    await api.search.query(search);

    expect(electron.invoke.mock.calls).toEqual([
      ['database:get-management-snapshot'],
      ['database:update-backup-policy', policy],
      ['database:export-data'],
      ['database:choose-import'],
      ['database:commit-import', { importId, previewDigest: 'a'.repeat(64) }],
      ['database:cancel-import', { importId }],
      ['search:query', search],
    ]);
  });

  it('subscribes and removes data-management state listeners', () => {
    const listener = vi.fn();
    const unsubscribe = api.database.onBackupStateChange(listener);
    expect(electron.on).toHaveBeenCalledExactlyOnceWith(
      'database:backup-state-changed',
      expect.any(Function),
    );
    const wrapped = electron.on.mock.calls[0]?.[1] as (event: unknown, payload: unknown) => void;
    const snapshot = { database: {}, backups: [], schedule: {} };
    wrapped({}, snapshot);
    expect(listener).toHaveBeenCalledExactlyOnceWith(snapshot);
    unsubscribe();
    expect(electron.removeListener).toHaveBeenCalledExactlyOnceWith(
      'database:backup-state-changed',
      wrapped,
    );
  });
});

describe('preload inbox API', () => {
  it('exposes only the declared inbox methods and capture event', () => {
    expect(Object.keys(api.inbox).sort()).toEqual([
      'archive',
      'categorize',
      'create',
      'getSnapshot',
      'onCaptureRequest',
      'undoArchive',
    ]);
    expect(Object.isFrozen(api)).toBe(true);
    expect(Object.isFrozen(api.inbox)).toBe(true);
  });

  it('forwards exact inputs through the allowlisted channels', async () => {
    const workspaceId = '123e4567-e89b-42d3-a456-426614174000';
    const entryId = '223e4567-e89b-42d3-a456-426614174000';
    const undoToken = '323e4567-e89b-42d3-a456-426614174000';

    await api.inbox.getSnapshot({ workspaceId });
    await api.inbox.create({ workspaceId, content: '记录', category: 'note' });
    await api.inbox.categorize({ workspaceId, entryId, category: 'task' });
    await api.inbox.archive({ workspaceId, entryId });
    await api.inbox.undoArchive({ workspaceId, undoToken });

    expect(electron.invoke.mock.calls).toEqual([
      ['inbox:get-snapshot', { workspaceId }],
      ['inbox:create', { workspaceId, content: '记录', category: 'note' }],
      ['inbox:categorize', { workspaceId, entryId, category: 'task' }],
      ['inbox:archive', { workspaceId, entryId }],
      ['inbox:undo-archive', { workspaceId, undoToken }],
    ]);
  });

  it('subscribes and removes the Main-triggered quick-capture listener', () => {
    const listener = vi.fn();
    const unsubscribe = api.inbox.onCaptureRequest(listener);
    expect(electron.on).toHaveBeenCalledWith('inbox:capture-requested', expect.any(Function));

    const wrapped = electron.on.mock.calls[0]?.[1] as (event: unknown, payload: unknown) => void;
    wrapped({}, undefined);
    expect(listener).toHaveBeenCalledTimes(1);
    unsubscribe();
    expect(electron.removeListener).toHaveBeenCalledWith('inbox:capture-requested', wrapped);
  });
});

describe('preload task API', () => {
  it('exposes only the declared frozen task methods', () => {
    expect(Object.keys(api.task).sort()).toEqual([
      'convertInbox',
      'create',
      'getSnapshot',
      'rename',
      'updatePlanning',
      'updateStatus',
    ]);
    expect(Object.isFrozen(api.task)).toBe(true);
  });

  it('forwards exact task inputs through the allowlisted channels', async () => {
    const workspaceId = '123e4567-e89b-42d3-a456-426614174000';
    const taskId = '423e4567-e89b-42d3-a456-426614174000';
    const entryId = '223e4567-e89b-42d3-a456-426614174000';

    await api.task.getSnapshot({ workspaceId });
    await api.task.create({ workspaceId, title: '真实任务', planning: 'today' });
    await api.task.rename({ workspaceId, taskId, title: '更新标题' });
    await api.task.updateStatus({ workspaceId, taskId, status: 'in_progress' });
    await api.task.updatePlanning({ workspaceId, taskId, planning: 'none' });
    await api.task.convertInbox({ workspaceId, entryId, planning: 'today' });

    expect(electron.invoke.mock.calls).toEqual([
      ['task:get-snapshot', { workspaceId }],
      ['task:create', { workspaceId, title: '真实任务', planning: 'today' }],
      ['task:rename', { workspaceId, taskId, title: '更新标题' }],
      ['task:update-status', { workspaceId, taskId, status: 'in_progress' }],
      ['task:update-planning', { workspaceId, taskId, planning: 'none' }],
      ['task:convert-inbox', { workspaceId, entryId, planning: 'today' }],
    ]);
  });
});

describe('preload note API', () => {
  it('exposes only the declared frozen note methods', () => {
    expect(Object.keys(api.note).sort()).toEqual([
      'archive',
      'convertInbox',
      'create',
      'getSnapshot',
      'update',
    ]);
    expect(Object.isFrozen(api.note)).toBe(true);
  });

  it('forwards exact note inputs through the allowlisted channels', async () => {
    const workspaceId = '123e4567-e89b-42d3-a456-426614174000';
    const noteId = '523e4567-e89b-42d3-a456-426614174000';
    const entryId = '223e4567-e89b-42d3-a456-426614174000';

    await api.note.getSnapshot({ workspaceId });
    await api.note.create({ workspaceId, title: '笔记', body: '# Markdown' });
    await api.note.update({
      workspaceId,
      noteId,
      title: '更新',
      body: '正文',
      expectedRevision: 1,
    });
    await api.note.archive({ workspaceId, noteId, expectedRevision: 2 });
    await api.note.convertInbox({ workspaceId, entryId });

    expect(electron.invoke.mock.calls).toEqual([
      ['note:get-snapshot', { workspaceId }],
      ['note:create', { workspaceId, title: '笔记', body: '# Markdown' }],
      ['note:update', { workspaceId, noteId, title: '更新', body: '正文', expectedRevision: 1 }],
      ['note:archive', { workspaceId, noteId, expectedRevision: 2 }],
      ['note:convert-inbox', { workspaceId, entryId }],
    ]);
  });
});

describe('preload schedule API', () => {
  it('exposes only the declared frozen schedule methods', () => {
    expect(Object.keys(api.schedule).sort()).toEqual([
      'archive',
      'create',
      'getSnapshot',
      'update',
    ]);
    expect(Object.isFrozen(api.schedule)).toBe(true);
  });

  it('forwards exact schedule inputs through the allowlisted channels', async () => {
    const workspaceId = '123e4567-e89b-42d3-a456-426614174000';
    const scheduleId = '623e4567-e89b-42d3-a456-426614174000';
    const expectedDate = '2026-07-22';

    await api.schedule.getSnapshot({ workspaceId });
    await api.schedule.create({
      workspaceId,
      expectedDate,
      title: '专注',
      kind: 'focus',
      startMinute: 540,
      endMinute: 600,
    });
    await api.schedule.update({
      workspaceId,
      scheduleId,
      expectedDate,
      expectedRevision: 1,
      title: '评审',
      kind: 'review',
      startMinute: 600,
      endMinute: 660,
    });
    await api.schedule.archive({
      workspaceId,
      scheduleId,
      expectedDate,
      expectedRevision: 2,
    });

    expect(electron.invoke.mock.calls).toEqual([
      ['schedule:get-snapshot', { workspaceId }],
      [
        'schedule:create',
        {
          workspaceId,
          expectedDate,
          title: '专注',
          kind: 'focus',
          startMinute: 540,
          endMinute: 600,
        },
      ],
      [
        'schedule:update',
        {
          workspaceId,
          scheduleId,
          expectedDate,
          expectedRevision: 1,
          title: '评审',
          kind: 'review',
          startMinute: 600,
          endMinute: 660,
        },
      ],
      ['schedule:archive', { workspaceId, scheduleId, expectedDate, expectedRevision: 2 }],
    ]);
  });
});

describe('preload automation API', () => {
  it('exposes only the declared frozen automation methods', () => {
    expect(Object.keys(api.automation).sort()).toEqual([
      'archive',
      'create',
      'getSnapshot',
      'onChanged',
      'setEnabled',
      'update',
    ]);
    expect(Object.isFrozen(api.automation)).toBe(true);
  });

  it('forwards exact automation inputs through allowlisted channels', async () => {
    const workspaceId = '123e4567-e89b-42d3-a456-426614174000';
    const automationId = 'b23e4567-e89b-42d3-a456-426614174000';
    const schedule = { cadence: 'daily' as const, localTimeMinute: 510, weekday: null };
    const action = { kind: 'create-today-task' as const, title: '检查今日计划' };

    await api.automation.getSnapshot({ workspaceId });
    await api.automation.create({ workspaceId, name: '每日准备', schedule, action });
    await api.automation.update({
      workspaceId,
      automationId,
      expectedRevision: 1,
      name: '每日检查',
      schedule,
      action,
    });
    await api.automation.setEnabled({
      workspaceId,
      automationId,
      expectedRevision: 2,
      enabled: true,
    });
    await api.automation.archive({
      workspaceId,
      automationId,
      expectedRevision: 3,
    });

    expect(electron.invoke.mock.calls).toEqual([
      ['automation:get-snapshot', { workspaceId }],
      ['automation:create', { workspaceId, name: '每日准备', schedule, action }],
      [
        'automation:update',
        {
          workspaceId,
          automationId,
          expectedRevision: 1,
          name: '每日检查',
          schedule,
          action,
        },
      ],
      ['automation:set-enabled', { workspaceId, automationId, expectedRevision: 2, enabled: true }],
      ['automation:archive', { workspaceId, automationId, expectedRevision: 3 }],
    ]);
  });

  it('subscribes and removes narrow automation change listeners', () => {
    const listener = vi.fn();
    const unsubscribe = api.automation.onChanged(listener);
    expect(electron.on).toHaveBeenCalledExactlyOnceWith('automation:changed', expect.any(Function));
    const wrapped = electron.on.mock.calls[0]?.[1] as (event: unknown, payload: unknown) => void;
    const payload = { workspaceId: 'workspace', reason: 'run', outputKind: 'task' };
    wrapped({}, payload);
    expect(listener).toHaveBeenCalledExactlyOnceWith(payload);
    unsubscribe();
    expect(electron.removeListener).toHaveBeenCalledExactlyOnceWith('automation:changed', wrapped);
  });
});

describe('preload assistant API', () => {
  it('exposes only the declared frozen assistant methods', () => {
    expect(Object.keys(api.assistant).sort()).toEqual([
      'cancel',
      'configureCredential',
      'getCredentialStatus',
      'getSnapshot',
      'onChanged',
      'removeCredential',
      'start',
    ]);
    expect(Object.isFrozen(api.assistant)).toBe(true);
  });

  it('forwards exact assistant inputs without exposing workspace or provider controls', async () => {
    const apiKey = `sk-proj-${'a'.repeat(48)}`;
    const runId = '123e4567-e89b-42d3-a456-426614174000';
    const start = {
      prompt: '梳理下一步',
      context: { kind: 'today' as const },
    };

    await api.assistant.getCredentialStatus();
    await api.assistant.configureCredential({ apiKey });
    await api.assistant.removeCredential();
    await api.assistant.getSnapshot();
    await api.assistant.start(start);
    await api.assistant.cancel({ runId });

    expect(electron.invoke.mock.calls).toEqual([
      ['assistant:get-credential-status'],
      ['assistant:configure-credential', { apiKey }],
      ['assistant:remove-credential'],
      ['assistant:get-snapshot'],
      ['assistant:start', start],
      ['assistant:cancel', { runId }],
    ]);
  });

  it('subscribes and removes assistant snapshot listeners', () => {
    const listener = vi.fn();
    const unsubscribe = api.assistant.onChanged(listener);
    expect(electron.on).toHaveBeenCalledExactlyOnceWith('assistant:changed', expect.any(Function));
    const wrapped = electron.on.mock.calls[0]?.[1] as (event: unknown, payload: unknown) => void;
    const payload = { sequence: 4, workspaceId: 'workspace', phase: 'running' };
    wrapped({}, payload);
    expect(listener).toHaveBeenCalledExactlyOnceWith(payload);
    unsubscribe();
    expect(electron.removeListener).toHaveBeenCalledExactlyOnceWith('assistant:changed', wrapped);
  });
});

describe('preload window API', () => {
  it('exposes only the declared frozen window methods', () => {
    expect(Object.keys(api.window).sort()).toEqual([
      'close',
      'minimize',
      'onCloseRequest',
      'toggleMaximize',
    ]);
    expect(Object.isFrozen(api.window)).toBe(true);
  });

  it('registers close protection before returning typed decisions to Main', async () => {
    const request = {
      requestId: '123e4567-e89b-42d3-a456-426614174000',
      reason: 'window' as const,
    };
    const listener = vi.fn(() => false);
    const unsubscribe = api.window.onCloseRequest(listener);

    expect(electron.on).toHaveBeenCalledExactlyOnceWith(
      'window:close-requested',
      expect.any(Function),
    );
    expect(electron.invoke).toHaveBeenCalledExactlyOnceWith('window:close-protection-ready');

    const wrapped = electron.on.mock.calls[0]?.[1] as (event: unknown, payload: unknown) => void;
    wrapped({}, request);
    await vi.waitFor(() => {
      expect(electron.invoke).toHaveBeenCalledWith('window:respond-close-request', {
        requestId: request.requestId,
        approved: false,
      });
    });
    expect(listener).toHaveBeenCalledExactlyOnceWith(request);

    unsubscribe();
    expect(electron.removeListener).toHaveBeenCalledExactlyOnceWith(
      'window:close-requested',
      wrapped,
    );
  });

  it('freezes an approved renderer before responding and restores it when delivery fails', async () => {
    class FocusedElement {
      public readonly blur = vi.fn();
    }
    const documentElement = { inert: false };
    const activeElement = new FocusedElement();
    vi.stubGlobal('HTMLElement', FocusedElement);
    vi.stubGlobal('document', { documentElement, activeElement });
    electron.invoke
      .mockImplementationOnce(() => Promise.resolve(undefined))
      .mockImplementationOnce(() => Promise.reject(new Error('response delivery failed')))
      .mockImplementationOnce(() => Promise.resolve(undefined));

    const request = {
      requestId: '123e4567-e89b-42d3-a456-426614174001',
      reason: 'application' as const,
    };
    const unsubscribe = api.window.onCloseRequest(() => true);
    const wrapped = electron.on.mock.calls[0]?.[1] as (event: unknown, payload: unknown) => void;

    wrapped({}, request);

    await vi.waitFor(() => {
      expect(electron.invoke).toHaveBeenCalledWith('window:respond-close-request', {
        requestId: request.requestId,
        approved: false,
      });
    });
    expect(activeElement.blur).toHaveBeenCalledTimes(1);
    expect(documentElement.inert).toBe(false);
    unsubscribe();
  });
});

describe('preload browser API', () => {
  it('exposes only the declared frozen browser methods', () => {
    expect(Object.keys(api.browser).sort()).toEqual([
      'activateTab',
      'back',
      'cancelDownload',
      'closeTab',
      'createTab',
      'dismissDownload',
      'forward',
      'getSnapshot',
      'navigate',
      'onFocusAddressRequest',
      'onOpenUrlRequest',
      'onStateChange',
      'openBookmark',
      'pauseDownload',
      'reload',
      'removeBookmark',
      'resumeDownload',
      'revealDownload',
      'setBounds',
      'setVisible',
      'stop',
      'toggleBookmark',
    ]);
    expect(Object.isFrozen(api.browser)).toBe(true);
  });

  it('forwards exact browser inputs through the allowlisted channels', async () => {
    const workspaceId = '123e4567-e89b-42d3-a456-426614174000';
    const tabId = '723e4567-e89b-42d3-a456-426614174000';
    const bookmarkId = '823e4567-e89b-42d3-a456-426614174000';
    const downloadId = '923e4567-e89b-42d3-a456-426614174000';
    const tabTarget = { workspaceId, tabId };
    const downloadTarget = { workspaceId, downloadId };

    await api.browser.getSnapshot({ workspaceId });
    await api.browser.createTab({ workspaceId, url: 'https://example.com/' });
    await api.browser.activateTab(tabTarget);
    await api.browser.closeTab(tabTarget);
    await api.browser.navigate({ ...tabTarget, url: 'https://example.com/docs' });
    await api.browser.back(tabTarget);
    await api.browser.forward(tabTarget);
    await api.browser.reload(tabTarget);
    await api.browser.stop(tabTarget);
    await api.browser.toggleBookmark(tabTarget);
    await api.browser.removeBookmark({ workspaceId, bookmarkId });
    await api.browser.openBookmark({ workspaceId, bookmarkId, newTab: true });
    await api.browser.pauseDownload(downloadTarget);
    await api.browser.resumeDownload(downloadTarget);
    await api.browser.cancelDownload(downloadTarget);
    await api.browser.dismissDownload(downloadTarget);
    await api.browser.revealDownload(downloadTarget);
    await api.browser.setBounds({
      workspaceId,
      bounds: { x: 10, y: 20, width: 430, height: 640 },
    });
    await api.browser.setVisible({ workspaceId, visible: true });

    expect(electron.invoke.mock.calls).toEqual([
      ['browser:get-snapshot', { workspaceId }],
      ['browser:create-tab', { workspaceId, url: 'https://example.com/' }],
      ['browser:activate-tab', tabTarget],
      ['browser:close-tab', tabTarget],
      ['browser:navigate', { ...tabTarget, url: 'https://example.com/docs' }],
      ['browser:back', tabTarget],
      ['browser:forward', tabTarget],
      ['browser:reload', tabTarget],
      ['browser:stop', tabTarget],
      ['browser:toggle-bookmark', tabTarget],
      ['browser:remove-bookmark', { workspaceId, bookmarkId }],
      ['browser:open-bookmark', { workspaceId, bookmarkId, newTab: true }],
      ['browser:pause-download', downloadTarget],
      ['browser:resume-download', downloadTarget],
      ['browser:cancel-download', downloadTarget],
      ['browser:dismiss-download', downloadTarget],
      ['browser:reveal-download', downloadTarget],
      ['browser:set-bounds', { workspaceId, bounds: { x: 10, y: 20, width: 430, height: 640 } }],
      ['browser:set-visible', { workspaceId, visible: true }],
    ]);
  });

  it('subscribes and removes browser state and focus listeners', () => {
    const stateListener = vi.fn();
    const focusListener = vi.fn();
    const openUrlListener = vi.fn();
    const unsubscribeState = api.browser.onStateChange(stateListener);
    const unsubscribeFocus = api.browser.onFocusAddressRequest(focusListener);
    const unsubscribeOpenUrl = api.browser.onOpenUrlRequest(openUrlListener);
    expect(electron.on).toHaveBeenNthCalledWith(1, 'browser:state-changed', expect.any(Function));
    expect(electron.on).toHaveBeenNthCalledWith(
      2,
      'browser:focus-address-requested',
      expect.any(Function),
    );
    expect(electron.on).toHaveBeenNthCalledWith(
      3,
      'browser:open-url-requested',
      expect.any(Function),
    );

    const wrappedState = electron.on.mock.calls[0]?.[1] as (
      event: unknown,
      payload: unknown,
    ) => void;
    const wrappedFocus = electron.on.mock.calls[1]?.[1] as (
      event: unknown,
      payload: unknown,
    ) => void;
    const wrappedOpenUrl = electron.on.mock.calls[2]?.[1] as (
      event: unknown,
      payload: unknown,
    ) => void;
    const snapshot = {
      workspaceId: '123e4567-e89b-42d3-a456-426614174000',
      revision: 1,
      activeTabId: '723e4567-e89b-42d3-a456-426614174000',
      tabs: [],
      bookmarks: [],
      downloads: [],
    };
    const openUrlRequest = {
      workspaceId: snapshot.workspaceId,
      url: 'https://example.com/',
    };
    wrappedState({}, snapshot);
    wrappedFocus({}, undefined);
    wrappedOpenUrl({}, openUrlRequest);
    expect(stateListener).toHaveBeenCalledWith(snapshot);
    expect(focusListener).toHaveBeenCalledTimes(1);
    expect(openUrlListener).toHaveBeenCalledWith(openUrlRequest);

    unsubscribeState();
    unsubscribeFocus();
    unsubscribeOpenUrl();
    expect(electron.removeListener).toHaveBeenCalledWith('browser:state-changed', wrappedState);
    expect(electron.removeListener).toHaveBeenCalledWith(
      'browser:focus-address-requested',
      wrappedFocus,
    );
    expect(electron.removeListener).toHaveBeenCalledWith(
      'browser:open-url-requested',
      wrappedOpenUrl,
    );
  });
});

describe('preload terminal API', () => {
  it('exposes only the declared frozen terminal methods and events', () => {
    expect(Object.keys(api.terminal).sort()).toEqual([
      'activate',
      'chooseWorkingDirectory',
      'clear',
      'close',
      'create',
      'getSnapshot',
      'onData',
      'onExit',
      'onStateChange',
      'refreshCapabilities',
      'resetWorkingDirectory',
      'resize',
      'restart',
      'updateProfile',
      'updateWslDistribution',
      'write',
    ]);
    expect(Object.isFrozen(api.terminal)).toBe(true);
  });

  it('forwards exact terminal input objects through allowlisted channels', async () => {
    const workspaceId = '123e4567-e89b-42d3-a456-426614174000';
    const sessionId = 'a23e4567-e89b-42d3-a456-426614174000';
    const target = { workspaceId, sessionId };
    const revisionTarget = { workspaceId, expectedRevision: 4 };
    const distributionId = `wsl-${'b'.repeat(64)}`;

    await api.terminal.getSnapshot({ workspaceId });
    await api.terminal.create({
      workspaceId,
      configurationRevision: 4,
      profileId: 'powershell-7',
    });
    await api.terminal.updateProfile({
      ...revisionTarget,
      profileId: 'powershell-7',
    });
    await api.terminal.updateWslDistribution({
      ...revisionTarget,
      capabilityRevision: 2,
      distributionId,
    });
    await api.terminal.chooseWorkingDirectory(revisionTarget);
    await api.terminal.resetWorkingDirectory(revisionTarget);
    await api.terminal.refreshCapabilities({ workspaceId });
    await api.terminal.activate(target);
    await api.terminal.restart(target);
    await api.terminal.write({ ...target, data: 'echo ok\r' });
    await api.terminal.resize({ ...target, columns: 120, rows: 32 });
    await api.terminal.clear(target);
    await api.terminal.close(target);

    expect(electron.invoke.mock.calls).toEqual([
      ['terminal:get-snapshot', { workspaceId }],
      ['terminal:create', { workspaceId, configurationRevision: 4, profileId: 'powershell-7' }],
      ['terminal:update-profile', { ...revisionTarget, profileId: 'powershell-7' }],
      [
        'terminal:update-wsl-distribution',
        {
          ...revisionTarget,
          capabilityRevision: 2,
          distributionId,
        },
      ],
      ['terminal:choose-working-directory', revisionTarget],
      ['terminal:reset-working-directory', revisionTarget],
      ['terminal:refresh-capabilities', { workspaceId }],
      ['terminal:activate', target],
      ['terminal:restart', target],
      ['terminal:write', { ...target, data: 'echo ok\r' }],
      ['terminal:resize', { ...target, columns: 120, rows: 32 }],
      ['terminal:clear', target],
      ['terminal:close', target],
    ]);
  });

  it('subscribes and removes terminal data, exit, and state listeners', () => {
    const dataListener = vi.fn();
    const exitListener = vi.fn();
    const stateListener = vi.fn();
    const unsubscribeData = api.terminal.onData(dataListener);
    const unsubscribeExit = api.terminal.onExit(exitListener);
    const unsubscribeState = api.terminal.onStateChange(stateListener);

    expect(electron.on).toHaveBeenNthCalledWith(1, 'terminal:data', expect.any(Function));
    expect(electron.on).toHaveBeenNthCalledWith(2, 'terminal:exit', expect.any(Function));
    expect(electron.on).toHaveBeenNthCalledWith(3, 'terminal:state-changed', expect.any(Function));

    const workspaceId = '123e4567-e89b-42d3-a456-426614174000';
    const sessionId = 'a23e4567-e89b-42d3-a456-426614174000';
    const data = { workspaceId, sessionId, sequence: 7, data: 'output' };
    const exit = { workspaceId, sessionId, exitCode: 0 };
    const snapshot = {
      workspaceId,
      revision: 2,
      activeSessionId: sessionId,
      sessions: [],
      profiles: [],
      configuration: {
        revision: 1,
        preferredProfileId: 'system-default',
        workingDirectory: {
          mode: 'user-home',
          displayPath: '/home/test',
          available: true,
        },
        wsl: {
          status: 'unsupported',
          capabilityRevision: 1,
          distributions: [],
          selectedDistributionId: null,
          selectedDistributionLabel: null,
          selectedDistributionAvailable: true,
        },
      },
    };
    const wrappedData = electron.on.mock.calls[0]?.[1] as (
      event: unknown,
      payload: unknown,
    ) => void;
    const wrappedExit = electron.on.mock.calls[1]?.[1] as (
      event: unknown,
      payload: unknown,
    ) => void;
    const wrappedState = electron.on.mock.calls[2]?.[1] as (
      event: unknown,
      payload: unknown,
    ) => void;

    wrappedData({}, data);
    wrappedExit({}, exit);
    wrappedState({}, snapshot);
    expect(dataListener).toHaveBeenCalledExactlyOnceWith(data);
    expect(exitListener).toHaveBeenCalledExactlyOnceWith(exit);
    expect(stateListener).toHaveBeenCalledExactlyOnceWith(snapshot);

    unsubscribeData();
    unsubscribeExit();
    unsubscribeState();
    expect(electron.removeListener).toHaveBeenCalledWith('terminal:data', wrappedData);
    expect(electron.removeListener).toHaveBeenCalledWith('terminal:exit', wrappedExit);
    expect(electron.removeListener).toHaveBeenCalledWith('terminal:state-changed', wrappedState);
  });
});
