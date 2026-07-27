/// <reference lib="dom" />

import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { DataManagementSnapshot, DatabaseBackupInfo } from '../src/shared/contracts';
import {
  BackupCreateSyncWarning,
  backupCreateSyncWarningOwnsFocus,
} from '../src/renderer/components/BackupCreateSyncWarning';
import { DataSettings } from '../src/renderer/components/SettingsPage';

describe('manual backup creation renderer surfaces', () => {
  it('renders one global alert with an exact, path-safe backup summary and recovery action', () => {
    const createdBackup = backup();
    const markup = renderToStaticMarkup(
      createElement(BackupCreateSyncWarning, {
        backup: createdBackup,
        focusActionOnMount: false,
        focusBlocked: false,
        blocked: false,
        refreshing: false,
        refreshError: null,
        onRefresh: () => undefined,
        onFocusFallback: () => undefined,
      }),
    );

    expect(markup).toContain(
      'class="task-create-toast task-create-sync-warning backup-create-sync-warning"',
    );
    expect(markup.match(/role="alert"/gu)).toHaveLength(1);
    expect(markup).toContain('aria-atomic="true"');
    expect(markup).toContain('aria-busy="false"');
    expect(markup).toContain('备份已创建，但列表未同步');
    expect(markup).toContain('请勿重复创建');
    expect(markup).toContain(`dateTime="${createdBackup.createdAt}"`);
    expect(markup).toContain('4.0 KiB');
    expect(markup).toContain('手动备份');
    expect(markup).toContain('Schema v11');
    expect(markup).not.toContain(createdBackup.id);
    expect(markup).not.toContain(createdBackup.fileName);
    expect(markup).toContain('重新读取备份列表并确认');
    expect(markup).not.toContain('再次备份');
  });

  it('exposes refreshing and a durable error without nesting another alert', () => {
    const markup = renderToStaticMarkup(
      createElement(BackupCreateSyncWarning, {
        backup: backup(),
        focusActionOnMount: true,
        focusBlocked: false,
        blocked: false,
        refreshing: true,
        refreshError: '重新读取后仍无法确认备份，请稍后重试。',
        onRefresh: () => undefined,
        onFocusFallback: () => undefined,
      }),
    );

    expect(markup).toContain('aria-busy="true"');
    expect(markup).toContain('disabled=""');
    expect(markup).toContain('正在读取…');
    expect(markup).toContain(
      'aria-describedby="backup-create-sync-warning-message backup-create-sync-warning-error"',
    );
    expect(markup).toContain('重新读取后仍无法确认备份，请稍后重试。');
    expect(markup.match(/role="alert"/gu)).toHaveLength(1);
  });

  it('disables recovery during another data operation without claiming that a read started', () => {
    const markup = renderToStaticMarkup(
      createElement(BackupCreateSyncWarning, {
        backup: backup(),
        focusActionOnMount: true,
        focusBlocked: false,
        blocked: true,
        refreshing: false,
        refreshError: null,
        onRefresh: () => undefined,
        onFocusFallback: () => undefined,
      }),
    );

    expect(markup).toContain('aria-busy="false"');
    expect(markup).toContain('disabled=""');
    expect(markup).toContain('重新读取');
    expect(markup).not.toContain('正在读取…');
  });

  it('keeps refresh single-flight and only moves focus while the warning owns it', () => {
    const source = componentSource('BackupCreateSyncWarning.tsx');
    const body = focusElement();
    const warningAction = focusElement() as HTMLButtonElement;
    const unrelatedAction = focusElement();
    const disabledManualBackupAction = focusElement({
      'data-backup-create-action': 'manual',
      disabled: '',
    });
    const enabledManualBackupAction = focusElement({
      'data-backup-create-action': 'manual',
    });

    expect(backupCreateSyncWarningOwnsFocus(null, body, warningAction)).toBe(true);
    expect(backupCreateSyncWarningOwnsFocus(body, body, warningAction)).toBe(true);
    expect(backupCreateSyncWarningOwnsFocus(warningAction, body, warningAction)).toBe(true);
    expect(backupCreateSyncWarningOwnsFocus(disabledManualBackupAction, body, warningAction)).toBe(
      true,
    );
    expect(backupCreateSyncWarningOwnsFocus(enabledManualBackupAction, body, warningAction)).toBe(
      false,
    );
    expect(backupCreateSyncWarningOwnsFocus(unrelatedAction, body, warningAction)).toBe(false);
    expect(source).toContain('if (blocked || refreshing || refreshRequestedRef.current) return;');
    expect(source).toContain('refreshRequestedRef.current = true;');
    expect(source).toContain('await onRefresh();');
    expect(source).toContain('refreshRequestedRef.current = false;');
    expect(source).toContain('focusBlocked ||');
    expect(source).toContain('document.activeElement === actionRef.current');
    expect(source).toContain('error.focus({ preventScroll: true });');
    expect(source).toContain('window.requestAnimationFrame(onFocusFallback)');
    expect(source).toContain('focusBlockedRef.current ||');
    expect(source).toContain('warningOwnedFocusRef.current');
  });

  it('blocks only manual backup creation while an unresolved commit is being reconciled', () => {
    const markup = renderToStaticMarkup(
      createElement(DataSettings, {
        snapshot: managementSnapshot(),
        status: 'ready',
        operation: null,
        feedback: null,
        manualBackupBlocked: true,
        onRetry: () => undefined,
        onCreateBackup: () => undefined,
        onRestoreBackup: async () => ({ status: 'cancelled' as const }),
        onUpdatePolicy: () => undefined,
        onExport: () => undefined,
        onChooseImport: () => undefined,
      }),
    );
    const settingsSource = componentSource('SettingsPage.tsx');
    const manualBackupButton = buttonContaining(markup, '立即备份');
    const exportButton = buttonContaining(markup, '导出数据');
    const importButton = buttonContaining(markup, '导入并替换本地数据');

    expect(manualBackupButton).toContain('data-backup-create-action="manual"');
    expect(manualBackupButton).toContain('disabled=""');
    expect(exportButton).not.toContain('disabled=""');
    expect(importButton).not.toContain('disabled=""');
    expect(settingsSource).toContain(
      'if (operation !== null || actionInFlightRef.current || blocked)',
    );
    expect(settingsSource).toContain('runAction(onCreateBackup, manualBackupBlocked)');
    expect(settingsSource).toContain('disabled={busy || manualBackupBlocked}');
  });
});

function componentSource(fileName: string): string {
  return readFileSync(new URL(`../src/renderer/components/${fileName}`, import.meta.url), 'utf8');
}

function focusElement(attributes: Readonly<Record<string, string>> = {}): HTMLElement {
  return {
    getAttribute(name: string): string | null {
      return Object.hasOwn(attributes, name) ? attributes[name] : null;
    },
  } as HTMLElement;
}

function buttonContaining(markup: string, text: string): string {
  return (
    markup
      .match(/<button\b[^>]*>[\s\S]*?<\/button>/gu)
      ?.find((candidate) => candidate.includes(text)) ?? ''
  );
}

function backup(): DatabaseBackupInfo {
  return {
    id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    fileName: '/Users/example/private/manual-backup.sqlite3',
    createdAt: '2026-07-27T20:15:30.000Z',
    sizeBytes: 4_096,
    reason: 'manual',
    schemaVersion: 11,
  };
}

function managementSnapshot(): DataManagementSnapshot {
  return {
    database: {
      schemaVersion: 11,
      appliedMigrations: 11,
      sqliteVersion: '3.53.1',
      journalMode: 'wal',
      integrityCheck: 'ok',
      backupCount: 1,
    },
    backups: [backup()],
    schedule: {
      policy: {
        enabled: true,
        cadence: 'daily',
        localTimeMinute: 120,
        weekday: null,
        retentionCount: 14,
        revision: 1,
        updatedAt: '2026-07-27T20:15:30.000Z',
      },
      lastAttemptAt: null,
      lastSuccessAt: null,
      lastErrorCode: null,
      consecutiveFailures: 0,
      nextRunAt: '2026-07-28T02:00:00.000Z',
      running: false,
    },
  };
}
