/// <reference lib="dom" />

import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { DataManagementSnapshot, DatabaseBackupInfo } from '../src/shared/contracts';
import {
  BackupHistoryDialog,
  BackupRestoreDialog,
} from '../src/renderer/components/BackupRestoreDialog';
import { DataSettings } from '../src/renderer/components/SettingsPage';

describe('backup restore renderer surfaces', () => {
  it('shows every recognized backup in an accessible history dialog', () => {
    const backups = [
      backup('older', '2026-07-20T08:00:00.000Z'),
      backup('newer', '2026-07-23T08:00:00.000Z'),
    ];
    const markup = renderToStaticMarkup(
      createElement(BackupHistoryDialog, {
        backups,
        busy: false,
        onClose: () => undefined,
        onRestore: () => undefined,
      }),
    );

    expect(markup).toContain('<dialog');
    expect(markup).toContain('aria-labelledby="backup-history-dialog-title"');
    expect(markup).toContain('aria-describedby="backup-history-dialog-description"');
    expect(markup).toContain('全部可恢复备份');
    expect(markup).toContain('backup-history-title-newer');
    expect(markup).toContain('backup-history-title-older');
    expect(markup.match(/>恢复<\/button>/gu)).toHaveLength(2);
    expect(markup.indexOf('backup-history-title-newer')).toBeLessThan(
      markup.indexOf('backup-history-title-older'),
    );
    expect(markup).toContain('不能选择路径或外部');
  });

  it('locks the selected target and discloses exactly what restore leaves untouched', () => {
    const markup = renderToStaticMarkup(
      createElement(BackupRestoreDialog, {
        backup: backup('target-backup', '2026-07-23T08:00:00.000Z'),
        busy: false,
        onClose: () => undefined,
        onConfirm: async () => ({ status: 'cancelled' as const }),
      }),
    );
    const source = readFileSync(
      new URL('../src/renderer/components/BackupRestoreDialog.tsx', import.meta.url),
      'utf8',
    );

    expect(markup).toContain('aria-labelledby="backup-restore-dialog-title"');
    expect(markup).toContain('恢复目标已经锁定');
    expect(markup).toContain('专注、自动化运行、浏览器页面和终端会话不会复活');
    expect(markup).toContain('API key');
    expect(markup).toContain('Cookie');
    expect(markup).toContain('下载记录和文件不会回滚');
    expect(markup).toContain('备份目录不会回滚');
    expect(markup).toContain('替换前安全备份');
    expect(markup).toContain('我了解恢复会完整替换当前数据库');
    expect(markup).toContain('type="checkbox"');
    expect(markup).toContain('class="backup-restore-dialog__confirm" disabled=""');
    expect(source).toContain('Object.freeze({ ...backup })');
    expect(source).toContain('createDatabaseBackupRestoreInput(target)');
  });

  it('locks dismissal and actions throughout verification, cancellation, and restart handoff', () => {
    const markup = renderToStaticMarkup(
      createElement(BackupRestoreDialog, {
        backup: backup('target-backup', '2026-07-23T08:00:00.000Z'),
        busy: true,
        onClose: () => undefined,
        onConfirm: async () => ({ status: 'restarting' as const }),
      }),
    );
    const source = readFileSync(
      new URL('../src/renderer/components/BackupRestoreDialog.tsx', import.meta.url),
      'utf8',
    );

    expect(markup).toContain('aria-busy="true"');
    expect(markup.match(/disabled=""/gu)?.length).toBeGreaterThanOrEqual(4);
    expect(markup).toContain('正在安全恢复…');
    expect(source).toContain('if (effectiveBusy) event.preventDefault()');
    expect(source).toContain('if (effectiveBusy || actionInFlightRef.current || !acknowledged)');
    expect(source).toContain('actionInFlightRef.current = true');
    expect(source).toMatch(
      /if \(result\.status === 'restarting'\) \{\s*setRestarting\(true\);\s*\} else \{\s*onClose\(\);\s*\}/u,
    );
  });

  it('keeps settings compact with five recent backups and an explicit full-history action', () => {
    const backups = Array.from({ length: 7 }, (_, index) =>
      backup(`backup-${index + 1}`, `2026-07-${String(index + 10).padStart(2, '0')}T08:00:00.000Z`),
    );
    const markup = renderToStaticMarkup(
      createElement(DataSettings, {
        snapshot: managementSnapshot(backups),
        status: 'ready',
        operation: null,
        feedback: null,
        onRetry: () => undefined,
        onCreateBackup: () => undefined,
        onRestoreBackup: async () => ({ status: 'cancelled' as const }),
        onUpdatePolicy: () => undefined,
        onExport: () => undefined,
        onChooseImport: () => undefined,
      }),
    );

    expect(markup).toContain('aria-label="最近五份备份"');
    expect(markup.match(/class="backup-list__restore"/gu)).toHaveLength(5);
    expect(markup).toContain('查看全部备份');
    expect(markup).toContain('>7</span>');
  });

  it('requires App-level unsaved-note approval before authorizing data replacement', () => {
    const source = readFileSync(new URL('../src/renderer/App.tsx', import.meta.url), 'utf8');

    expect(source).toContain('if (!confirmLeaveNoteDraft()) return null');
    expect(source).toContain('dataReplacementApprovedRef.current = true');
    expect(source).toContain('dataReplacementNoteDiscardApprovedRef.current = true');
    expect(source).toContain("if (result.status === 'cancelled')");
    expect(source).toContain('onRestoreBackup={restoreBackupWithApproval}');
  });
});

function backup(id: string, createdAt: string): DatabaseBackupInfo {
  return {
    id,
    fileName: `${id}.sqlite3`,
    createdAt,
    sizeBytes: 4_096,
    reason: 'manual',
    schemaVersion: 11,
  };
}

function managementSnapshot(backups: readonly DatabaseBackupInfo[]): DataManagementSnapshot {
  return {
    database: {
      schemaVersion: 11,
      appliedMigrations: 11,
      sqliteVersion: '3.53.1',
      journalMode: 'wal',
      integrityCheck: 'ok',
      backupCount: backups.length,
    },
    backups,
    schedule: {
      policy: {
        enabled: true,
        cadence: 'daily',
        localTimeMinute: 120,
        weekday: null,
        retentionCount: 14,
        revision: 1,
        updatedAt: '2026-07-23T08:00:00.000Z',
      },
      lastAttemptAt: null,
      lastSuccessAt: null,
      lastErrorCode: null,
      consecutiveFailures: 0,
      nextRunAt: '2026-07-24T02:00:00.000Z',
      running: false,
    },
  };
}
