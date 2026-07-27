import { describe, expect, it } from 'vitest';
import {
  ScheduleMutationCoordinator,
  type ScheduleMutationKind,
} from '../src/renderer/schedule-mutation-coordinator';
import { createScheduleWorkspaceIdentity } from '../src/renderer/schedule-state';

const WORKSPACE_A = '11111111-1111-4111-8111-111111111111';
const WORKSPACE_B = '22222222-2222-4222-8222-222222222222';
const MUTATION_KINDS: readonly ScheduleMutationKind[] = ['create', 'update', 'archive', 'recover'];

describe('schedule mutation coordinator', () => {
  it('keeps every mutation kind single-flight per workspace while allowing parallel workspaces', () => {
    const workspaceA = createScheduleWorkspaceIdentity(WORKSPACE_A);
    const workspaceB = createScheduleWorkspaceIdentity(WORKSPACE_B);
    const coordinator = new ScheduleMutationCoordinator();
    const createA = coordinator.begin(workspaceA, 'create');
    const updateB = coordinator.begin(workspaceB, 'update');

    expect(createA).not.toBeNull();
    expect(updateB).not.toBeNull();
    expect(createA).toMatchObject({
      generation: 1,
      workspace: workspaceA,
      workspaceId: WORKSPACE_A,
      kind: 'create',
    });
    expect(Object.isFrozen(createA)).toBe(true);
    expect(updateB?.generation).toBe(2);
    for (const kind of MUTATION_KINDS) {
      expect(coordinator.begin(workspaceA, kind)).toBeNull();
    }
    expect(coordinator.isPending(WORKSPACE_A)).toBe(true);
    expect(coordinator.isPending(WORKSPACE_B)).toBe(true);
    expect(coordinator.isActive(createA!)).toBe(true);
    expect(coordinator.isCurrent(createA!, workspaceA)).toBe(true);
    expect(coordinator.isCurrent(updateB!, workspaceB)).toBe(true);

    coordinator.end(createA!);
    expect(coordinator.isActive(createA!)).toBe(false);
    expect(coordinator.isPending(WORKSPACE_A)).toBe(false);
    expect(coordinator.isPending(WORKSPACE_B)).toBe(true);
  });

  it.each(MUTATION_KINDS)('can own and release a %s lease', (kind) => {
    const workspace = createScheduleWorkspaceIdentity(WORKSPACE_A);
    const coordinator = new ScheduleMutationCoordinator();
    const intent = coordinator.begin(workspace, kind);

    expect(intent?.kind).toBe(kind);
    expect(coordinator.isCurrent(intent!, workspace)).toBe(true);
    coordinator.end(intent!);
    expect(coordinator.isPending(WORKSPACE_A)).toBe(false);
  });

  it('does not revive an intent after an A to B to A activation cycle', () => {
    const firstA = createScheduleWorkspaceIdentity(WORKSPACE_A);
    const workspaceB = createScheduleWorkspaceIdentity(WORKSPACE_B);
    const secondA = createScheduleWorkspaceIdentity(WORKSPACE_A);
    const coordinator = new ScheduleMutationCoordinator();
    const intent = coordinator.begin(firstA, 'update')!;

    expect(coordinator.isCurrent(intent, firstA)).toBe(true);
    expect(coordinator.isCurrent(intent, workspaceB)).toBe(false);
    expect(coordinator.isCurrent(intent, secondA)).toBe(false);
    expect(coordinator.canPublishWarning(intent, workspaceB)).toBe(false);
    expect(coordinator.canPublishWarning(intent, secondA)).toBe(true);
    expect(coordinator.isActive(intent)).toBe(true);
    expect(coordinator.begin(secondA, 'archive')).toBeNull();
  });

  it('lets only the owning intent release a newer same-workspace lease', () => {
    const workspace = createScheduleWorkspaceIdentity(WORKSPACE_A);
    const coordinator = new ScheduleMutationCoordinator();
    const first = coordinator.begin(workspace, 'archive')!;

    coordinator.invalidateAll();
    const replacement = coordinator.begin(workspace, 'recover')!;
    coordinator.end(first);

    expect(replacement.generation).toBeGreaterThan(first.generation);
    expect(coordinator.isCurrent(first, workspace)).toBe(false);
    expect(coordinator.isCurrent(replacement, workspace)).toBe(true);
    expect(coordinator.isPending(WORKSPACE_A)).toBe(true);
    coordinator.end(replacement);
    expect(coordinator.isPending(WORKSPACE_A)).toBe(false);
  });

  it('invalidates all workspaces without letting stale end calls affect replacements', () => {
    const workspaceA = createScheduleWorkspaceIdentity(WORKSPACE_A);
    const workspaceB = createScheduleWorkspaceIdentity(WORKSPACE_B);
    const coordinator = new ScheduleMutationCoordinator();
    const oldA = coordinator.begin(workspaceA, 'create')!;
    const oldB = coordinator.begin(workspaceB, 'update')!;

    coordinator.invalidateAll();
    expect(coordinator.isActive(oldA)).toBe(false);
    expect(coordinator.isActive(oldB)).toBe(false);
    expect(coordinator.isPending(WORKSPACE_A)).toBe(false);
    expect(coordinator.isPending(WORKSPACE_B)).toBe(false);

    const replacementA = coordinator.begin(workspaceA, 'recover')!;
    coordinator.end(oldA);
    coordinator.end(oldB);
    expect(coordinator.isCurrent(replacementA, workspaceA)).toBe(true);
    coordinator.end(replacementA);
  });

  it('rejects an unavailable workspace and treats null as not pending', () => {
    const coordinator = new ScheduleMutationCoordinator();

    expect(coordinator.begin(createScheduleWorkspaceIdentity(null), 'create')).toBeNull();
    expect(coordinator.isPending(null)).toBe(false);
  });
});
