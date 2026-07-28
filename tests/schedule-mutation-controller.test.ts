import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const controllerSource = readFileSync(
  new URL('../src/renderer/hooks/useScheduleController.ts', import.meta.url),
  'utf8',
);

describe('schedule mutation controller contract', () => {
  it('returns complete update and archive commit envelopes', () => {
    expect(controllerSource).toContain('export interface ScheduleUpdateCommit');
    expect(controllerSource).toContain('readonly intent: ScheduleUpdateMutationIntent');
    expect(controllerSource).toContain('readonly updatedSchedule: ScheduleItem | null');
    expect(controllerSource).toContain('export interface ScheduleArchiveCommit');
    expect(controllerSource).toContain('readonly intent: ScheduleArchiveMutationIntent');
    expect(controllerSource).toContain('readonly confirmed: boolean');
    expect(controllerSource).toContain('readonly reconciliationWarning: string | null');
    expect(controllerSource).toContain('export type ScheduleMutationRecovery');
  });

  it('separates retryable Main update failures from fail-closed reconciliation', () => {
    const updateFlow = sourceBetween(
      controllerSource,
      'const update = useCallback(',
      'const archive = useCallback(',
    );
    const reconciliationStart = updateFlow.indexOf(
      'const reconciliation = await reconcileScheduleUpdateResult',
    );
    expect(reconciliationStart).toBeGreaterThanOrEqual(0);
    const mainMutation = updateFlow.slice(0, reconciliationStart);
    const postCommit = updateFlow.slice(reconciliationStart);

    expect(mainMutation).toContain('result = await window.workbench.schedule.update');
    expect(mainMutation).toContain('throw operationFailure(');
    expect(postCommit).toContain('updatedSchedule: reconciliation.authoritativeSchedule');
    expect(postCommit).toContain('committed: reconciliation.committed');
    expect(postCommit).toContain('SCHEDULE_UPDATE_RECONCILIATION_ERROR');
    expect(postCommit).not.toContain('operationFailure(');
    expect(postCommit).not.toContain('throw reconciliation');
  });

  it('separates retryable Main archive failures from fail-closed reconciliation', () => {
    const archiveFlow = sourceBetween(
      controllerSource,
      'const archive = useCallback(',
      'const recoverScheduleMutation = useCallback(',
    );
    const reconciliationStart = archiveFlow.indexOf(
      'const reconciliation = await reconcileScheduleArchiveResult',
    );
    expect(reconciliationStart).toBeGreaterThanOrEqual(0);
    const mainMutation = archiveFlow.slice(0, reconciliationStart);
    const postCommit = archiveFlow.slice(reconciliationStart);

    expect(mainMutation).toContain('result = await window.workbench.schedule.archive');
    expect(mainMutation).toContain('throw operationFailure(');
    expect(postCommit).toContain('confirmed: reconciliation.confirmed');
    expect(postCommit).toContain('committed: reconciliation.committed');
    expect(postCommit).toContain('SCHEDULE_ARCHIVE_RECONCILIATION_ERROR');
    expect(postCommit).not.toContain('operationFailure(');
    expect(postCommit).not.toContain('throw reconciliation');
  });

  it('recovers only from committed snapshots and bounded authoritative refreshes', () => {
    const recoveryFlow = sourceBetween(
      controllerSource,
      'const recoverScheduleMutation = useCallback(',
      'const getCommittedSnapshot = useCallback(',
    );

    expect(recoveryFlow).toContain('commitResultSnapshot: () => false');
    expect(recoveryFlow).toContain(
      'scheduleSnapshotForActivation(target, storedSnapshotRef.current, new Date())',
    );
    expect(recoveryFlow).toContain('prepareSnapshotRefresh');
    expect(recoveryFlow).toContain('reconcileScheduleUpdateResult');
    expect(recoveryFlow).toContain('reconcileScheduleArchiveResult');
    expect(recoveryFlow).not.toContain('window.workbench.schedule.update');
    expect(recoveryFlow).not.toContain('window.workbench.schedule.archive');
  });

  it('preserves per-item single-flight guards and exposes activation-safe snapshots', () => {
    const updateFlow = sourceBetween(
      controllerSource,
      'const update = useCallback(',
      'const archive = useCallback(',
    );
    const archiveFlow = sourceBetween(
      controllerSource,
      'const archive = useCallback(',
      'const recoverScheduleMutation = useCallback(',
    );
    const recoveryFlow = sourceBetween(
      controllerSource,
      'const recoverScheduleMutation = useCallback(',
      'const getCommittedSnapshot = useCallback(',
    );
    for (const flow of [updateFlow, archiveFlow, recoveryFlow]) {
      expect(flow).toContain('beginPendingItem(');
      expect(flow).toContain('endPendingItem(');
    }

    expect(controllerSource).toContain('const getCommittedSnapshot = useCallback(');
    const returnedController = controllerSource.slice(controllerSource.lastIndexOf('return {'));
    expect(returnedController).toContain('activation,');
    expect(returnedController).toContain('getCommittedSnapshot,');
    expect(returnedController).toContain('recoverScheduleMutation,');
  });
});

function sourceBetween(source: string, start: string, end: string): string {
  const startIndex = source.indexOf(start);
  const endIndex = source.indexOf(end, startIndex + start.length);
  expect(startIndex, `missing source marker: ${start}`).toBeGreaterThanOrEqual(0);
  expect(endIndex, `missing source marker: ${end}`).toBeGreaterThan(startIndex);
  return source.slice(startIndex, endIndex);
}
