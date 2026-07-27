import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const appSource = rendererSource('App.tsx');

describe('schedule mutation App reconciliation', () => {
  it.each([
    {
      name: 'update',
      start: '  const updateSchedule = useCallback(',
      end: '  const archiveSchedule = useCallback(',
      begin: "scheduleMutationCoordinator.begin(activation, 'update')",
      mutate: 'await scheduleController.update(',
      warning: 'scheduleUpdateSyncWarning(commit)',
    },
    {
      name: 'archive',
      start: '  const archiveSchedule = useCallback(',
      end: '  const refreshScheduleMutationSyncWarning = useCallback(',
      begin: "scheduleMutationCoordinator.begin(activation, 'archive')",
      mutate: 'await scheduleController.archive(',
      warning: 'scheduleArchiveSyncWarning(commit)',
    },
  ])(
    'holds the workspace-wide lease through committed $name reconciliation',
    ({ start, end, begin, mutate, warning }) => {
      const source = sourceBetween(appSource, start, end);
      const beginIndex = source.indexOf(begin);
      const mutateIndex = source.indexOf(mutate);
      const warningIndex = source.indexOf(warning);
      const endIndex = source.indexOf('scheduleMutationCoordinator.end(coordinatorIntent)');

      expect(beginIndex).toBeGreaterThanOrEqual(0);
      expect(mutateIndex).toBeGreaterThan(beginIndex);
      expect(warningIndex).toBeGreaterThan(mutateIndex);
      expect(endIndex).toBeGreaterThan(warningIndex);
      expect(source).toContain('if (scheduleWriteIsBlocked(activation))');
      expect(source).toContain('!commit.committed');
      expect(source).toContain(
        'scheduleMutationCoordinator.canPublishWarning(coordinatorIntent, publicationActivation)',
      );
      expect(source).toContain('publishScheduleMutationSyncWarning(');
      expect(source).toContain('finally {');
    },
  );

  it('recovers only the exact current warning without replaying its Main mutation', () => {
    const source = sourceBetween(
      appSource,
      '  const refreshScheduleMutationSyncWarning = useCallback(',
      '  const invalidateScheduleMutations = useCallback(',
    );

    expect(source).toMatch(
      /scheduleMutationCoordinator\.begin\(\s*publication\.activation,\s*'recover',?\s*\)/u,
    );
    expect(source).toContain('await scheduleController.recoverScheduleMutation(publication)');
    expect(source).toContain('isSamePublication(scheduleMutationSyncWarningRef.current)');
    expect(source).toContain(
      'recovery.updatedSchedule.id === publication.intent.originalSchedule.id',
    );
    expect(source).toContain('recovery.committed && recovery.confirmed');
    expect(source).toContain('scheduleMutationSyncWarningRef.current = null;');
    expect(source).toContain('refreshing: true');
    expect(source).toContain('refreshError:');
    expect(source).not.toContain('scheduleController.update(');
    expect(source).not.toContain('scheduleController.archive(');
  });

  it('keeps one App-level warning and routes dialog mutations through guarded wrappers', () => {
    const dialogSource = sourceBetween(appSource, '{scheduleDialog ?', '{automationDialog ?');
    const warningSource = sourceBetween(
      appSource,
      '{visibleScheduleMutationSyncWarning ?',
      '{visibleScheduleCreateFeedback ?',
    );

    expect(dialogSource).toContain('await updateSchedule(');
    expect(dialogSource).toContain('await archiveSchedule(item, scheduleDialog.expectedDate);');
    expect(dialogSource).not.toContain('await scheduleController.update(');
    expect(dialogSource).not.toContain('await scheduleController.archive(');
    expect(warningSource).toContain('<ScheduleMutationSyncWarning');
    expect(warningSource).toContain('focusActionOnMount=');
    expect(warningSource).toContain('focusBlocked={overlayOpen}');
    expect(warningSource).toContain('blocked={dataState.activeOperation !== null}');
    expect(warningSource).toContain('refreshing=');
    expect(warningSource).toContain('refreshError=');
    expect(warningSource).toContain('refreshScheduleMutationSyncWarning(');
    expect(warningSource).toContain('restoreScheduleMutationWarningFocus(');
    expect(appSource).toContain('scheduleMutationBlocked={scheduleWorkspaceChangeBlocked}');
  });

  it('blocks workspace and search navigation until the exact warning is resolved', () => {
    const workspaceSource = sourceBetween(
      appSource,
      '  const requestWorkspaceActivation = useCallback(',
      '  const createWorkspace = useCallback(',
    );
    const searchSource = sourceBetween(
      appSource,
      '  const selectSearchResult = useCallback(',
      '  const commands = useMemo<PaletteCommand[]>',
    );
    const editSource = sourceBetween(
      appSource,
      '  const openScheduleEdit = useCallback(',
      '  const createManualSchedule = useCallback(',
    );

    expect(workspaceSource.indexOf('scheduleWorkspaceChangeIsBlocked()')).toBeLessThan(
      workspaceSource.indexOf('workspaceController.activate(workspaceId)'),
    );
    expect(searchSource.indexOf('scheduleWorkspaceChangeIsBlocked()')).toBeLessThan(
      searchSource.indexOf('workspaceController.activate(result.workspaceId)'),
    );
    expect(searchSource.indexOf("selectedResult.kind === 'schedule'")).toBeLessThan(
      searchSource.indexOf('window.workbench.schedule.getSnapshot('),
    );
    expect(editSource).toContain('scheduleMutationCoordinator.isPending(activation.workspaceId)');
    expect(editSource).toContain('scheduleWriteIsBlocked(activation)');
    expect(rendererComponentSource('RollingPlan.tsx')).toContain('data-schedule-id={item.id}');
    expect(rendererComponentSource('RollingPlan.tsx')).toContain('disabled={pending || blocked}');
    expect(rendererComponentSource('TodayDashboard.tsx')).toContain('data-schedule-id={item.id}');
    expect(rendererComponentSource('TodayDashboard.tsx')).toContain(
      'disabled={pending || scheduleMutationBlocked}',
    );
  });

  it('holds the same lease across create-receipt opening and create-warning recovery', () => {
    const openSource = sourceBetween(
      appSource,
      '  const openCreatedSchedule = useCallback(',
      '  const dismissScheduleCreate = useCallback(',
    );
    const refreshSource = sourceBetween(
      appSource,
      '  const refreshScheduleCreateSyncWarning = useCallback(',
      '  const createManualAutomation = useCallback(',
    );
    const warningRender = sourceBetween(
      appSource,
      '{visibleScheduleCreateSyncWarning ?',
      '{visibleScheduleMutationSyncWarning ?',
    );
    const toastRender = sourceBetween(
      appSource,
      '{visibleScheduleCreateFeedback ?',
      '{visibleTaskCreateSyncWarning ?',
    );

    for (const source of [openSource, refreshSource]) {
      const beginIndex = source.indexOf(
        "scheduleMutationCoordinator.begin(mutationActivation, 'recover')",
      );
      const readIndex = source.indexOf('scheduleController.prepareSnapshotRefresh');
      const endIndex = source.indexOf('scheduleMutationCoordinator.end(mutationIntent)');
      expect(beginIndex).toBeGreaterThanOrEqual(0);
      expect(readIndex).toBeGreaterThan(beginIndex);
      expect(endIndex).toBeGreaterThan(readIndex);
      expect(source).toContain('scheduleWriteIsBlocked(mutationActivation)');
      expect(source).toContain('scheduleNavigationIntentRef.current = mutationIntent');
      expect(source).toContain('setScheduleNavigationPending(true)');
      expect(source).toContain('scheduleNavigationIntentRef.current === mutationIntent');
      expect(source).toContain('setScheduleNavigationPending(false)');
    }
    expect(warningRender).toContain('blocked={scheduleWorkspaceChangeBlocked}');
    expect(warningRender).toContain('blockedReason=');
    expect(toastRender).toContain('blocked={scheduleWorkspaceChangeBlocked}');
    expect(toastRender).toContain('blockedReason=');
  });

  it('invalidates recovery only after a real data replacement commits', () => {
    const restoreSource = sourceBetween(
      appSource,
      '  const restoreBackupWithApproval = useCallback(',
      '  const restoreManualBackupSyncWarningFocus = useCallback(',
    );
    const importSource = sourceBetween(appSource, '{dataState.importPreview ?', '<InboxUndoStack');
    const closeSource = sourceBetween(
      appSource,
      'window.workbench.window.onCloseRequest',
      'const protectDraft',
    );

    expect(restoreSource).toContain(
      'scheduleMutationCoordinator.isPending(currentWorkspaceIdRef.current)',
    );
    expect(restoreSource).toContain("if (result.status === 'cancelled')");
    expect(restoreSource.indexOf('invalidateScheduleMutations();')).toBeGreaterThan(
      restoreSource.indexOf('} else {'),
    );
    expect(importSource).toContain(
      'scheduleMutationCoordinator.isPending(currentWorkspaceIdRef.current)',
    );
    expect(importSource.indexOf('invalidateScheduleMutations();')).toBeGreaterThan(
      importSource.indexOf('await commitImport();'),
    );
    expect(closeSource.indexOf('invalidateScheduleMutations();')).toBeGreaterThan(
      closeSource.indexOf('dataReplacementCloseApproved(request.reason, decision)'),
    );
  });
});

function rendererSource(file: string): string {
  return readFileSync(new URL(`../src/renderer/${file}`, import.meta.url), 'utf8');
}

function rendererComponentSource(file: string): string {
  return readFileSync(new URL(`../src/renderer/components/${file}`, import.meta.url), 'utf8');
}

function sourceBetween(source: string, start: string, end: string): string {
  const startIndex = source.indexOf(start);
  const endIndex = source.indexOf(end, startIndex + start.length);
  expect(startIndex, `missing source marker: ${start}`).toBeGreaterThanOrEqual(0);
  expect(endIndex, `missing source marker: ${end}`).toBeGreaterThan(startIndex);
  return source.slice(startIndex, endIndex);
}
