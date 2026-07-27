import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const appSource = readFileSync(new URL('../src/renderer/App.tsx', import.meta.url), 'utf8');

describe('automation run App reconciliation', () => {
  it('holds the workspace intent through Main success and exact output reconciliation', () => {
    const start = appSource.indexOf('  const runAutomationNow = useCallback(');
    const end = appSource.indexOf(
      '\n  const refreshAutomationRunSyncWarning = useCallback(',
      start,
    );
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    const source = appSource.slice(start, end);

    const begin = source.indexOf('automationRunReconciliationCoordinator.begin(');
    const run = source.indexOf('await automationController.runNow(item)');
    const reconcile = source.indexOf('await reconcileAutomationRunFeedback(feedback, isCurrent)');
    const publish = source.indexOf("kind: 'feedback'");
    const finish = source.indexOf('finishAutomationRunIntent(intent)');

    expect(begin).toBeGreaterThanOrEqual(0);
    expect(run).toBeGreaterThan(begin);
    expect(reconcile).toBeGreaterThan(run);
    expect(publish).toBeGreaterThan(reconcile);
    expect(finish).toBeGreaterThan(publish);
    expect(source).toContain('automationRunReconciliationCoordinator.isActive(intent)');
    expect(source).toContain("kind: 'warning'");
    expect(source).toContain("phase: 'running'");
    expect(source).toContain("phase: 'confirming'");
    expect(source).toContain('setAutomationRunActivity(');
  });

  it('recovers only the exact current warning and promotes it after a committed refresh', () => {
    const start = appSource.indexOf('  const refreshAutomationRunSyncWarning = useCallback(');
    const end = appSource.indexOf('\n  const openAutomationRunOutput = useCallback(', start);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    const source = appSource.slice(start, end);

    expect(source).toContain('automationRunFeedbackKey(currentPublication.feedback)');
    expect(source).toContain('`recover:${feedbackKey}`');
    expect(source).toContain('await reconcileAutomationRunFeedback(feedback, isCurrent)');
    expect(source).toContain('!reconciliation.committed || !isCurrent()');
    expect(source).toContain("kind: 'feedback'");
    expect(source).toContain("phase: 'recovering'");
    expect(source).toContain('refreshing: true');
    expect(source).toContain('refreshError:');
    expect(source).toContain('finishAutomationRunIntent(intent)');
  });

  it('keeps warning state in App, blocks all run actions, and clears it only for real replacement', () => {
    expect(appSource).toContain(
      'const [automationRunPublications, setAutomationRunPublications] = useState<',
    );
    expect(appSource).toContain(
      'const [automationRunActivities, setAutomationRunActivities] = useState<',
    );
    expect(appSource).toContain(
      'visibleAutomationRunActivity !== null || visibleAutomationRunSyncWarning !== null',
    );
    expect(appSource).toContain('runSyncWarning={visibleAutomationRunSyncWarning}');
    expect(appSource).toContain('runActivity={visibleAutomationRunActivity}');
    expect(appSource).toContain(
      'runSyncWarningRefreshing={visibleAutomationRunSyncWarningRefreshing}',
    );
    expect(appSource).toContain('runSyncWarningError={visibleAutomationRunSyncWarningError}');
    expect(appSource).toContain('runSyncWarningFocusBlocked={overlayOpen}');
    expect(appSource).toContain('runBlocked={automationRunBlocked}');
    expect(appSource).toContain('onRunNow={runAutomationNow}');
    expect(appSource).toContain('onRefreshRunSyncWarning={refreshAutomationRunSyncWarning}');

    const replacementApproval = appSource.indexOf(
      'if (dataReplacementCloseApproved(request.reason, decision))',
    );
    expect(replacementApproval).toBeGreaterThanOrEqual(0);
    expect(appSource.slice(replacementApproval, replacementApproval + 500)).toContain(
      'invalidateAutomationRuns();',
    );
  });

  it('reads ref-backed committed snapshots and mirrors automation errors only once', () => {
    expect(appSource).toContain(
      'const getCommittedTaskSnapshot = taskController.getCommittedSnapshot;',
    );
    expect(appSource).toContain(
      'const getCommittedNoteSnapshot = noteController.getCommittedSnapshot;',
    );
    expect(appSource).toContain('getCommittedTaskSnapshot(feedback.workspaceId)');
    expect(appSource).toContain('getCommittedNoteSnapshot(feedback.workspaceId)');
    expect(appSource).toContain(
      "(statusbarErrorSource === 'automation' && activeSurface === 'automations')",
    );
  });
});
