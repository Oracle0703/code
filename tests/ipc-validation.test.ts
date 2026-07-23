import { describe, expect, it } from 'vitest';
import {
  assertNoArguments,
  parseBoolean,
  parseBrowserBookmarkTargetInput,
  parseBrowserBounds,
  parseBrowserBoundsInput,
  parseBrowserCreateTabInput,
  parseBrowserDownloadTargetInput,
  parseBrowserNavigateInput,
  parseBrowserOpenBookmarkInput,
  parseBrowserTabTargetInput,
  parseBrowserVisibilityInput,
  parseBrowserWorkspaceInput,
  parseInboxCategorizeInput,
  parseInboxCreateInput,
  parseInboxTargetInput,
  parseInboxUndoInput,
  parseNoteArchiveInput,
  parseNoteConvertInboxInput,
  parseNoteCreateInput,
  parseNoteUpdateInput,
  parseScheduleCreateInput,
  parseScheduleTargetInput,
  parseScheduleUpdateInput,
  parseTaskConvertInboxInput,
  parseTaskCreateInput,
  parseTaskPlanningInput,
  parseTaskRenameInput,
  parseTaskStatusInput,
  parseSessionId,
  parseTerminalCreateInput,
  parseTerminalResizeInput,
  parseTerminalSessionTargetInput,
  parseTerminalWorkspaceInput,
  parseTerminalWriteInput,
  parseWindowCloseResponse,
  parseWorkspaceCreateInput,
  parseWorkspacePreferencesInput,
  parseWorkspaceRenameInput,
  parseWorkspaceTargetInput,
} from '../src/main/ipc/validation';
import { WORKSPACE_COLORS } from '../src/shared/contracts';

const WORKSPACE_ID = '123e4567-e89b-42d3-a456-426614174000';
const ENTRY_ID = '223e4567-e89b-42d3-a456-426614174000';
const UNDO_TOKEN = '323e4567-e89b-42d3-a456-426614174000';
const TASK_ID = '423e4567-e89b-42d3-a456-426614174000';
const NOTE_ID = '523e4567-e89b-42d3-a456-426614174000';
const SCHEDULE_ID = '623e4567-e89b-42d3-a456-426614174000';
const TAB_ID = '723e4567-e89b-42d3-a456-426614174000';
const BOOKMARK_ID = '823e4567-e89b-42d3-a456-426614174000';
const DOWNLOAD_ID = '923e4567-e89b-42d3-a456-426614174000';

describe('IPC validation', () => {
  it('accepts integer browser bounds in the supported range', () => {
    expect(parseBrowserBounds({ x: 80, y: 120, width: 480, height: 620 })).toEqual({
      x: 80,
      y: 120,
      width: 480,
      height: 620,
    });
  });

  it.each([
    { x: -1, y: 0, width: 100, height: 100 },
    { x: 0.5, y: 0, width: 100, height: 100 },
    { x: 0, y: 0, width: 100, height: 100, extra: true },
  ])('rejects malformed browser bounds', (bounds) => {
    expect(() => parseBrowserBounds(bounds)).toThrow(TypeError);
  });

  it('accepts exact workspace-bound browser operations', () => {
    expect(parseBrowserWorkspaceInput({ workspaceId: WORKSPACE_ID })).toEqual({
      workspaceId: WORKSPACE_ID,
    });
    expect(parseBrowserCreateTabInput({ workspaceId: WORKSPACE_ID })).toEqual({
      workspaceId: WORKSPACE_ID,
    });
    expect(
      parseBrowserCreateTabInput({
        workspaceId: WORKSPACE_ID,
        url: ' https://example.com/path ',
      }),
    ).toEqual({ workspaceId: WORKSPACE_ID, url: 'https://example.com/path' });
    expect(parseBrowserTabTargetInput({ workspaceId: WORKSPACE_ID, tabId: TAB_ID })).toEqual({
      workspaceId: WORKSPACE_ID,
      tabId: TAB_ID,
    });
    expect(
      parseBrowserNavigateInput({
        workspaceId: WORKSPACE_ID,
        tabId: TAB_ID,
        url: 'https://example.com/',
      }),
    ).toEqual({ workspaceId: WORKSPACE_ID, tabId: TAB_ID, url: 'https://example.com/' });
    expect(
      parseBrowserBookmarkTargetInput({
        workspaceId: WORKSPACE_ID,
        bookmarkId: BOOKMARK_ID,
      }),
    ).toEqual({ workspaceId: WORKSPACE_ID, bookmarkId: BOOKMARK_ID });
    expect(
      parseBrowserOpenBookmarkInput({
        workspaceId: WORKSPACE_ID,
        bookmarkId: BOOKMARK_ID,
        newTab: true,
      }),
    ).toEqual({ workspaceId: WORKSPACE_ID, bookmarkId: BOOKMARK_ID, newTab: true });
    expect(
      parseBrowserDownloadTargetInput({
        workspaceId: WORKSPACE_ID,
        downloadId: DOWNLOAD_ID,
      }),
    ).toEqual({ workspaceId: WORKSPACE_ID, downloadId: DOWNLOAD_ID });
    expect(
      parseBrowserBoundsInput({
        workspaceId: WORKSPACE_ID,
        bounds: { x: 10, y: 20, width: 430, height: 640 },
      }),
    ).toEqual({
      workspaceId: WORKSPACE_ID,
      bounds: { x: 10, y: 20, width: 430, height: 640 },
    });
    expect(parseBrowserVisibilityInput({ workspaceId: WORKSPACE_ID, visible: false })).toEqual({
      workspaceId: WORKSPACE_ID,
      visible: false,
    });
  });

  it('rejects forged browser ids, paths, fields, booleans, and control characters', () => {
    expect(() =>
      parseBrowserTabTargetInput({ workspaceId: WORKSPACE_ID, tabId: '../../tab' }),
    ).toThrow(TypeError);
    expect(() =>
      parseBrowserDownloadTargetInput({
        workspaceId: WORKSPACE_ID,
        downloadId: DOWNLOAD_ID,
        path: '/tmp/escape',
      }),
    ).toThrow(TypeError);
    expect(() =>
      parseBrowserNavigateInput({
        workspaceId: WORKSPACE_ID,
        tabId: TAB_ID,
        url: 'https://exa\u0000mple.com',
      }),
    ).toThrow(TypeError);
    expect(() =>
      parseBrowserOpenBookmarkInput({
        workspaceId: WORKSPACE_ID,
        bookmarkId: BOOKMARK_ID,
        newTab: 'true',
      }),
    ).toThrow(TypeError);
    expect(() =>
      parseBrowserBoundsInput({
        workspaceId: WORKSPACE_ID,
        bounds: { x: 0, y: 0, width: 430, height: 640 },
        tabId: TAB_ID,
      }),
    ).toThrow(TypeError);
  });

  it('accepts exact workspace-bound terminal operations', () => {
    const sessionId = 'a23e4567-e89b-42d3-a456-426614174000';
    expect(parseTerminalWorkspaceInput({ workspaceId: WORKSPACE_ID })).toEqual({
      workspaceId: WORKSPACE_ID,
    });
    expect(
      parseTerminalCreateInput({
        workspaceId: WORKSPACE_ID,
        profileId: 'powershell-7',
      }),
    ).toEqual({
      workspaceId: WORKSPACE_ID,
      profileId: 'powershell-7',
    });
    expect(parseTerminalSessionTargetInput({ workspaceId: WORKSPACE_ID, sessionId })).toEqual({
      workspaceId: WORKSPACE_ID,
      sessionId,
    });
    expect(
      parseTerminalWriteInput({
        workspaceId: WORKSPACE_ID,
        sessionId,
        data: '\u0003echo ok\r',
      }),
    ).toEqual({
      workspaceId: WORKSPACE_ID,
      sessionId,
      data: '\u0003echo ok\r',
    });
    expect(
      parseTerminalResizeInput({
        workspaceId: WORKSPACE_ID,
        sessionId,
        columns: 120,
        rows: 32,
      }),
    ).toEqual({
      workspaceId: WORKSPACE_ID,
      sessionId,
      columns: 120,
      rows: 32,
    });
  });

  it('rejects unsupported terminal profiles, dimensions, and surplus fields', () => {
    const sessionId = 'a23e4567-e89b-42d3-a456-426614174000';
    expect(() =>
      parseTerminalCreateInput({ workspaceId: WORKSPACE_ID, profileId: 'fish' }),
    ).toThrow(TypeError);
    expect(() =>
      parseTerminalCreateInput({
        workspaceId: WORKSPACE_ID,
        profileId: 'system-default',
        cwd: 'C:\\work',
      }),
    ).toThrow(TypeError);
    expect(() =>
      parseTerminalResizeInput({
        workspaceId: WORKSPACE_ID,
        sessionId,
        columns: 0,
        rows: 32,
      }),
    ).toThrow(TypeError);
    expect(() =>
      parseTerminalResizeInput({
        workspaceId: WORKSPACE_ID,
        sessionId,
        columns: 120,
        rows: 1_001,
      }),
    ).toThrow(TypeError);
    expect(() =>
      parseTerminalSessionTargetInput({
        workspaceId: WORKSPACE_ID,
        sessionId,
        path: '/tmp/escape',
      }),
    ).toThrow(TypeError);
    expect(() =>
      parseTerminalWriteInput({
        workspaceId: WORKSPACE_ID,
        sessionId,
        data: 'x'.repeat(1_048_577),
      }),
    ).toThrow(TypeError);
  });

  it('accepts only lowercase UUID v4 terminal session identifiers', () => {
    const sessionId = 'a23e4567-e89b-42d3-a456-426614174000';
    expect(parseSessionId(sessionId)).toBe(sessionId);
    expect(() => parseSessionId(sessionId.toUpperCase())).toThrow(TypeError);
    expect(() => parseSessionId('../../another-session')).toThrow(TypeError);
  });

  it('does not coerce boolean values', () => {
    expect(parseBoolean(true, 'visible')).toBe(true);
    expect(() => parseBoolean('true', 'visible')).toThrow(TypeError);
  });

  it('accepts only exact close responses with a lowercase UUID v4', () => {
    expect(
      parseWindowCloseResponse({
        requestId: WORKSPACE_ID,
        approved: false,
      }),
    ).toEqual({ requestId: WORKSPACE_ID, approved: false });
    expect(() => parseWindowCloseResponse({ requestId: WORKSPACE_ID, approved: 'false' })).toThrow(
      TypeError,
    );
    expect(() =>
      parseWindowCloseResponse({
        requestId: WORKSPACE_ID,
        approved: true,
        path: '/tmp/escape',
      }),
    ).toThrow(TypeError);
  });

  it('rejects surplus arguments for parameterless operations', () => {
    expect(() => assertNoArguments([], 'Creating a database backup')).not.toThrow();
    expect(() =>
      assertNoArguments(['/tmp/attacker.sqlite3'], 'Creating a database backup'),
    ).toThrow(TypeError);
  });

  it('normalizes bounded workspace names and accepts only palette colors', () => {
    expect(
      parseWorkspaceCreateInput({ name: '  Ａlpha 工作区  ', color: WORKSPACE_COLORS[1] }),
    ).toEqual({ name: 'Alpha 工作区', color: WORKSPACE_COLORS[1] });
    expect(() => parseWorkspaceCreateInput({ name: '', color: WORKSPACE_COLORS[0] })).toThrow(
      TypeError,
    );
    expect(() => parseWorkspaceCreateInput({ name: 'x\n', color: WORKSPACE_COLORS[0] })).toThrow(
      TypeError,
    );
    expect(() =>
      parseWorkspaceCreateInput({
        name: `x${String.fromCodePoint(0x85)}`,
        color: WORKSPACE_COLORS[0],
      }),
    ).toThrow(TypeError);
    expect(() => parseWorkspaceCreateInput({ name: 'x', color: '#ffffff' })).toThrow(TypeError);
    expect(() =>
      parseWorkspaceCreateInput({ name: 'x', color: WORKSPACE_COLORS[0], id: WORKSPACE_ID }),
    ).toThrow(TypeError);
  });

  it('requires exact workspace target and rename objects with UUID v4 ids', () => {
    expect(parseWorkspaceTargetInput({ workspaceId: WORKSPACE_ID })).toEqual({
      workspaceId: WORKSPACE_ID,
    });
    expect(parseWorkspaceRenameInput({ workspaceId: WORKSPACE_ID, name: '新的名称' })).toEqual({
      workspaceId: WORKSPACE_ID,
      name: '新的名称',
    });
    expect(() => parseWorkspaceTargetInput({ workspaceId: '../../workspace' })).toThrow(TypeError);
    expect(() => parseWorkspaceTargetInput({ workspaceId: WORKSPACE_ID.toUpperCase() })).toThrow(
      TypeError,
    );
    expect(() => parseWorkspaceTargetInput({ workspaceId: WORKSPACE_ID, extra: true })).toThrow(
      TypeError,
    );
  });

  it('accepts non-empty preference patches and rejects coercion or unknown keys', () => {
    expect(
      parseWorkspacePreferencesInput({
        workspaceId: WORKSPACE_ID,
        patch: { activeView: 'notes', browserOpen: false, terminalHeight: 420 },
      }),
    ).toEqual({
      workspaceId: WORKSPACE_ID,
      patch: { activeView: 'notes', browserOpen: false, terminalHeight: 420 },
    });
    expect(() => parseWorkspacePreferencesInput({ workspaceId: WORKSPACE_ID, patch: {} })).toThrow(
      TypeError,
    );
    expect(() =>
      parseWorkspacePreferencesInput({
        workspaceId: WORKSPACE_ID,
        patch: { browserOpen: 'false' },
      }),
    ).toThrow(TypeError);
    expect(() =>
      parseWorkspacePreferencesInput({
        workspaceId: WORKSPACE_ID,
        patch: { browserWidth: 721 },
      }),
    ).toThrow(TypeError);
    expect(() =>
      parseWorkspacePreferencesInput({
        workspaceId: WORKSPACE_ID,
        patch: { theme: 'system' },
      }),
    ).toThrow(TypeError);
    expect(() =>
      parseWorkspacePreferencesInput({
        workspaceId: WORKSPACE_ID,
        patch: { theme: 'light', databasePath: '/tmp/escape' },
      }),
    ).toThrow(TypeError);
  });

  it('accepts exact inbox capture and categorization inputs without rewriting content', () => {
    expect(
      parseInboxCreateInput({
        workspaceId: WORKSPACE_ID,
        content: '  ＡPI e\u0301 👩‍💻  ',
        category: 'uncategorized',
      }),
    ).toEqual({
      workspaceId: WORKSPACE_ID,
      content: 'ＡPI e\u0301 👩‍💻',
      category: 'uncategorized',
    });
    expect(
      parseInboxCategorizeInput({
        workspaceId: WORKSPACE_ID,
        entryId: ENTRY_ID,
        category: 'task',
      }),
    ).toEqual({ workspaceId: WORKSPACE_ID, entryId: ENTRY_ID, category: 'task' });
  });

  it('requires lowercase UUIDs and exact keys for inbox targets and undo tokens', () => {
    expect(parseInboxTargetInput({ workspaceId: WORKSPACE_ID, entryId: ENTRY_ID })).toEqual({
      workspaceId: WORKSPACE_ID,
      entryId: ENTRY_ID,
    });
    expect(parseInboxUndoInput({ workspaceId: WORKSPACE_ID, undoToken: UNDO_TOKEN })).toEqual({
      workspaceId: WORKSPACE_ID,
      undoToken: UNDO_TOKEN,
    });
    expect(() =>
      parseInboxTargetInput({ workspaceId: WORKSPACE_ID, entryId: ENTRY_ID, archived: true }),
    ).toThrow(TypeError);
    expect(() =>
      parseInboxUndoInput({ workspaceId: WORKSPACE_ID, undoToken: UNDO_TOKEN.toUpperCase() }),
    ).toThrow(TypeError);
    expect(() =>
      parseInboxCategorizeInput({
        workspaceId: WORKSPACE_ID,
        entryId: ENTRY_ID,
        category: 'idea',
      }),
    ).toThrow(TypeError);
  });

  it('rejects unsafe inbox content and renderer-owned persistence fields', () => {
    for (const content of ['', '  ', 'line one\nline two', '\u0000', 'x'.repeat(501)]) {
      expect(() =>
        parseInboxCreateInput({
          workspaceId: WORKSPACE_ID,
          content,
          category: 'note',
        }),
      ).toThrow(TypeError);
    }
    expect(() =>
      parseInboxCreateInput({
        workspaceId: WORKSPACE_ID,
        content: '不能伪造字段',
        category: 'note',
        id: ENTRY_ID,
        archivedAt: new Date().toISOString(),
      }),
    ).toThrow(TypeError);
  });

  it('accepts exact task operations while preserving Unicode title content', () => {
    expect(
      parseTaskCreateInput({
        workspaceId: WORKSPACE_ID,
        title: '  ＡPI e\u0301 👩‍💻  ',
        planning: 'today',
      }),
    ).toEqual({
      workspaceId: WORKSPACE_ID,
      title: 'ＡPI e\u0301 👩‍💻',
      planning: 'today',
    });
    expect(
      parseTaskRenameInput({ workspaceId: WORKSPACE_ID, taskId: TASK_ID, title: '新的标题' }),
    ).toEqual({ workspaceId: WORKSPACE_ID, taskId: TASK_ID, title: '新的标题' });
    expect(
      parseTaskStatusInput({
        workspaceId: WORKSPACE_ID,
        taskId: TASK_ID,
        status: 'completed',
      }),
    ).toEqual({ workspaceId: WORKSPACE_ID, taskId: TASK_ID, status: 'completed' });
    expect(
      parseTaskPlanningInput({
        workspaceId: WORKSPACE_ID,
        taskId: TASK_ID,
        planning: 'none',
      }),
    ).toEqual({ workspaceId: WORKSPACE_ID, taskId: TASK_ID, planning: 'none' });
    expect(
      parseTaskConvertInboxInput({
        workspaceId: WORKSPACE_ID,
        entryId: ENTRY_ID,
        planning: 'today',
      }),
    ).toEqual({ workspaceId: WORKSPACE_ID, entryId: ENTRY_ID, planning: 'today' });
  });

  it('rejects invalid task values and renderer-owned persistence fields', () => {
    for (const title of ['', '  ', 'line one\nline two', '\u0000', 'x'.repeat(501)]) {
      expect(() =>
        parseTaskCreateInput({ workspaceId: WORKSPACE_ID, title, planning: 'today' }),
      ).toThrow(TypeError);
    }
    expect(() =>
      parseTaskStatusInput({ workspaceId: WORKSPACE_ID, taskId: TASK_ID, status: 'blocked' }),
    ).toThrow(TypeError);
    expect(() =>
      parseTaskPlanningInput({ workspaceId: WORKSPACE_ID, taskId: TASK_ID, planning: 'tomorrow' }),
    ).toThrow(TypeError);
    expect(() =>
      parseTaskRenameInput({
        workspaceId: WORKSPACE_ID,
        taskId: TASK_ID.toUpperCase(),
        title: '无效 ID',
      }),
    ).toThrow(TypeError);
    expect(() =>
      parseTaskCreateInput({
        workspaceId: WORKSPACE_ID,
        title: '不能伪造字段',
        planning: 'today',
        id: TASK_ID,
        sourceInboxEntryId: ENTRY_ID,
        completedAt: new Date().toISOString(),
      }),
    ).toThrow(TypeError);
    expect(() =>
      parseTaskConvertInboxInput({
        workspaceId: WORKSPACE_ID,
        entryId: ENTRY_ID,
        planning: 'today',
        title: '不能覆盖来源正文',
      }),
    ).toThrow(TypeError);
  });

  it('accepts exact note inputs while preserving Markdown and revision CAS', () => {
    expect(
      parseNoteCreateInput({
        workspaceId: WORKSPACE_ID,
        title: '  技术笔记 👩‍💻  ',
        body: '# 标题\r\n\r\n```ts\r\nconst n = 1;\r\n```',
      }),
    ).toEqual({
      workspaceId: WORKSPACE_ID,
      title: '技术笔记 👩‍💻',
      body: '# 标题\n\n```ts\nconst n = 1;\n```',
    });
    expect(
      parseNoteUpdateInput({
        workspaceId: WORKSPACE_ID,
        noteId: NOTE_ID,
        title: '更新',
        body: '',
        expectedRevision: 2,
      }),
    ).toEqual({
      workspaceId: WORKSPACE_ID,
      noteId: NOTE_ID,
      title: '更新',
      body: '',
      expectedRevision: 2,
    });
    expect(
      parseNoteArchiveInput({
        workspaceId: WORKSPACE_ID,
        noteId: NOTE_ID,
        expectedRevision: 3,
      }),
    ).toEqual({
      workspaceId: WORKSPACE_ID,
      noteId: NOTE_ID,
      expectedRevision: 3,
    });
    expect(parseNoteConvertInboxInput({ workspaceId: WORKSPACE_ID, entryId: ENTRY_ID })).toEqual({
      workspaceId: WORKSPACE_ID,
      entryId: ENTRY_ID,
    });
  });

  it('rejects malformed notes and renderer-owned note persistence fields', () => {
    for (const revision of [0, -1, 1.5, '1']) {
      expect(() =>
        parseNoteArchiveInput({
          workspaceId: WORKSPACE_ID,
          noteId: NOTE_ID,
          expectedRevision: revision,
        }),
      ).toThrow(TypeError);
    }
    expect(() =>
      parseNoteCreateInput({
        workspaceId: WORKSPACE_ID,
        title: '伪造字段',
        body: '',
        id: NOTE_ID,
      }),
    ).toThrow(TypeError);
    expect(() =>
      parseNoteUpdateInput({
        workspaceId: WORKSPACE_ID,
        noteId: NOTE_ID,
        title: '控制字符',
        body: 'bad\u0000body',
        expectedRevision: 1,
      }),
    ).toThrow(TypeError);
  });

  it('accepts exact schedule inputs with bounded minutes and stale-date tokens', () => {
    expect(
      parseScheduleCreateInput({
        workspaceId: WORKSPACE_ID,
        expectedDate: '2026-07-22',
        title: '  评审  ',
        kind: 'review',
        startMinute: 0,
        endMinute: 1,
      }),
    ).toEqual({
      workspaceId: WORKSPACE_ID,
      expectedDate: '2026-07-22',
      title: '评审',
      kind: 'review',
      startMinute: 0,
      endMinute: 1,
    });
    expect(
      parseScheduleUpdateInput({
        workspaceId: WORKSPACE_ID,
        scheduleId: SCHEDULE_ID,
        expectedDate: '2026-07-22',
        expectedRevision: 2,
        title: '会议',
        kind: 'meeting',
        startMinute: 1439,
        endMinute: 1440,
      }),
    ).toEqual({
      workspaceId: WORKSPACE_ID,
      scheduleId: SCHEDULE_ID,
      expectedDate: '2026-07-22',
      expectedRevision: 2,
      title: '会议',
      kind: 'meeting',
      startMinute: 1439,
      endMinute: 1440,
    });
    expect(
      parseScheduleTargetInput({
        workspaceId: WORKSPACE_ID,
        scheduleId: SCHEDULE_ID,
        expectedDate: '2026-07-22',
        expectedRevision: 3,
      }),
    ).toEqual({
      workspaceId: WORKSPACE_ID,
      scheduleId: SCHEDULE_ID,
      expectedDate: '2026-07-22',
      expectedRevision: 3,
    });
  });

  it('rejects invalid schedule ranges, dates, enums, revisions, and surplus fields', () => {
    for (const input of [
      { startMinute: -1, endMinute: 1 },
      { startMinute: 60, endMinute: 60 },
      { startMinute: 1439, endMinute: 1441 },
      { startMinute: 1.5, endMinute: 2 },
    ]) {
      expect(() =>
        parseScheduleCreateInput({
          workspaceId: WORKSPACE_ID,
          expectedDate: '2026-07-22',
          title: '非法范围',
          kind: 'focus',
          ...input,
        }),
      ).toThrow(TypeError);
    }
    expect(() =>
      parseScheduleCreateInput({
        workspaceId: WORKSPACE_ID,
        expectedDate: '2026-02-30',
        title: '非法日期',
        kind: 'focus',
        startMinute: 1,
        endMinute: 2,
      }),
    ).toThrow(TypeError);
    expect(() =>
      parseScheduleTargetInput({
        workspaceId: WORKSPACE_ID,
        scheduleId: SCHEDULE_ID,
        expectedDate: '2026-07-22',
        expectedRevision: 0,
      }),
    ).toThrow(TypeError);
    expect(() =>
      parseScheduleCreateInput({
        workspaceId: WORKSPACE_ID,
        expectedDate: '2026-07-22',
        title: '伪造字段',
        kind: 'external',
        startMinute: 1,
        endMinute: 2,
        scheduledFor: '2026-07-22',
      }),
    ).toThrow(TypeError);
  });
});
