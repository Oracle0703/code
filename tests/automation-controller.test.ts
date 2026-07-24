import { describe, expect, it, vi } from 'vitest';
import {
  AutomationController,
  type AutomationControllerDatabase,
} from '../src/main/automations/automation-controller';
import type {
  AutomationRunNowResult,
  AutomationSnapshot,
  AutomationTargetInput,
} from '../src/shared/contracts';

const WORKSPACE_ID = '11111111-1111-4111-8111-111111111111';
const AUTOMATION_ID = '22222222-2222-4222-8222-222222222222';
const TASK_ID = '33333333-3333-4333-8333-333333333333';

describe('AutomationController manual execution', () => {
  it('returns the database result and emits one run event after success', async () => {
    const result: AutomationRunNowResult = {
      workspaceId: WORKSPACE_ID,
      automationId: AUTOMATION_ID,
      outputKind: 'task',
      outputId: TASK_ID,
    };
    const database = createDatabase();
    database.runAutomationNow.mockResolvedValue(result);
    const onChanged = vi.fn();
    const controller = new AutomationController({ database, onChanged });
    const input: AutomationTargetInput = {
      workspaceId: WORKSPACE_ID,
      automationId: AUTOMATION_ID,
      expectedRevision: 2,
    };

    await expect(controller.runNow(input)).resolves.toEqual(result);
    expect(database.runAutomationNow).toHaveBeenCalledExactlyOnceWith(input);
    expect(onChanged).toHaveBeenCalledExactlyOnceWith({
      workspaceId: WORKSPACE_ID,
      reason: 'run',
      outputKind: 'task',
    });
    expect(database.readAutomationSchedulerEntries).not.toHaveBeenCalled();
    expect(database.runAutomationOccurrence).not.toHaveBeenCalled();
  });

  it('does not emit a run event when the database rejects execution', async () => {
    const database = createDatabase();
    const failure = new Error('stale automation');
    database.runAutomationNow.mockRejectedValue(failure);
    const onChanged = vi.fn();
    const controller = new AutomationController({ database, onChanged });

    await expect(
      controller.runNow({
        workspaceId: WORKSPACE_ID,
        automationId: AUTOMATION_ID,
        expectedRevision: 1,
      }),
    ).rejects.toBe(failure);
    expect(onChanged).not.toHaveBeenCalled();
  });
});

function createDatabase() {
  const snapshot: AutomationSnapshot = { workspaceId: WORKSPACE_ID, items: [] };
  return {
    getAutomationSnapshot: vi.fn(async () => snapshot),
    createAutomation: vi.fn(async () => snapshot),
    updateAutomation: vi.fn(async () => snapshot),
    setAutomationEnabled: vi.fn(async () => snapshot),
    archiveAutomation: vi.fn(async () => snapshot),
    runAutomationNow: vi.fn<AutomationControllerDatabase['runAutomationNow']>(),
    readAutomationSchedulerEntries: vi.fn(async () => []),
    runAutomationOccurrence: vi.fn(),
  } satisfies AutomationControllerDatabase;
}
