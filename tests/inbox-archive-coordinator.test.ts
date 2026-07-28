import { describe, expect, it } from 'vitest';
import { InboxArchiveCoordinator } from '../src/renderer/inbox-archive-coordinator';
import { createInboxWorkspaceIdentity } from '../src/renderer/inbox-state';

const WORKSPACE_A = '11111111-1111-4111-8111-111111111111';
const WORKSPACE_B = '22222222-2222-4222-8222-222222222222';
const TOKEN_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const TOKEN_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

describe('inbox archive coordinator', () => {
  it('keeps one lease per workspace while allowing parallel workspaces', () => {
    const workspaceA = createInboxWorkspaceIdentity(WORKSPACE_A);
    const workspaceB = createInboxWorkspaceIdentity(WORKSPACE_B);
    const coordinator = new InboxArchiveCoordinator();
    const archiveA = coordinator.begin(workspaceA, 'archive');
    const undoB = coordinator.begin(workspaceB, 'undo', TOKEN_B);

    expect(archiveA).toMatchObject({
      epoch: 0,
      generation: 1,
      workspace: workspaceA,
      workspaceId: WORKSPACE_A,
      kind: 'archive',
      undoToken: null,
    });
    expect(undoB).toMatchObject({
      epoch: 0,
      generation: 2,
      workspace: workspaceB,
      workspaceId: WORKSPACE_B,
      kind: 'undo',
      undoToken: TOKEN_B,
    });
    expect(Object.isFrozen(archiveA)).toBe(true);
    expect(coordinator.begin(workspaceA, 'recover')).toBeNull();
    expect(coordinator.isPending(WORKSPACE_A)).toBe(true);
    expect(coordinator.isPending(WORKSPACE_B)).toBe(true);
    expect(coordinator.isCurrent(archiveA!, workspaceA)).toBe(true);
    expect(coordinator.isCurrent(undoB!, workspaceB)).toBe(true);

    coordinator.end(archiveA!);
    expect(coordinator.isPending(WORKSPACE_A)).toBe(false);
    expect(coordinator.isPending(WORKSPACE_B)).toBe(true);
  });

  it('keeps an undo token globally single-flight across workspaces and activations', () => {
    const firstA = createInboxWorkspaceIdentity(WORKSPACE_A);
    const workspaceB = createInboxWorkspaceIdentity(WORKSPACE_B);
    const secondA = createInboxWorkspaceIdentity(WORKSPACE_A);
    const coordinator = new InboxArchiveCoordinator();
    const undo = coordinator.begin(firstA, 'undo', TOKEN_A)!;

    expect(coordinator.isTokenPending(TOKEN_A)).toBe(true);
    expect(coordinator.begin(workspaceB, 'undo', TOKEN_A)).toBeNull();
    expect(coordinator.isCurrent(undo, firstA)).toBe(true);
    expect(coordinator.isCurrent(undo, workspaceB)).toBe(false);
    expect(coordinator.isCurrent(undo, secondA)).toBe(false);
    expect(coordinator.canPublishWarning(undo, workspaceB)).toBe(false);
    expect(coordinator.canPublishWarning(undo, secondA)).toBe(true);
    expect(coordinator.begin(secondA, 'undo', TOKEN_A)).toBeNull();

    coordinator.end(undo);
    expect(coordinator.isTokenPending(TOKEN_A)).toBe(false);
    expect(coordinator.begin(secondA, 'undo', TOKEN_A)).not.toBeNull();
  });

  it('allows recoveries with or without a token while honoring both lease classes', () => {
    const workspaceA = createInboxWorkspaceIdentity(WORKSPACE_A);
    const workspaceB = createInboxWorkspaceIdentity(WORKSPACE_B);
    const coordinator = new InboxArchiveCoordinator();
    const archiveRecovery = coordinator.begin(workspaceA, 'recover')!;
    const undoRecovery = coordinator.begin(workspaceB, 'recover', TOKEN_A)!;

    expect(archiveRecovery.kind).toBe('recover');
    expect(archiveRecovery.undoToken).toBeNull();
    expect(undoRecovery.undoToken).toBe(TOKEN_A);
    expect(coordinator.isTokenPending(TOKEN_A)).toBe(true);
    expect(coordinator.begin(createInboxWorkspaceIdentity(null), 'archive')).toBeNull();
  });

  it('lets only the owning intent release a newer same-workspace and same-token lease', () => {
    const workspace = createInboxWorkspaceIdentity(WORKSPACE_A);
    const coordinator = new InboxArchiveCoordinator();
    const first = coordinator.begin(workspace, 'undo', TOKEN_A)!;

    coordinator.invalidate(WORKSPACE_A);
    const replacement = coordinator.begin(workspace, 'undo', TOKEN_A)!;
    coordinator.end(first);

    expect(replacement.generation).toBeGreaterThan(first.generation);
    expect(coordinator.isCurrent(first, workspace)).toBe(false);
    expect(coordinator.isCurrent(replacement, workspace)).toBe(true);
    expect(coordinator.isPending(WORKSPACE_A)).toBe(true);
    expect(coordinator.isTokenPending(TOKEN_A)).toBe(true);

    coordinator.end(replacement);
    expect(coordinator.isPending(WORKSPACE_A)).toBe(false);
    expect(coordinator.isTokenPending(TOKEN_A)).toBe(false);
  });

  it('advances the database epoch without allowing old finally calls to release new work', () => {
    const workspaceA = createInboxWorkspaceIdentity(WORKSPACE_A);
    const workspaceB = createInboxWorkspaceIdentity(WORKSPACE_B);
    const coordinator = new InboxArchiveCoordinator();
    const oldA = coordinator.begin(workspaceA, 'undo', TOKEN_A)!;
    const oldB = coordinator.begin(workspaceB, 'archive')!;

    coordinator.advanceEpoch();
    expect(coordinator.epoch).toBe(1);
    expect(coordinator.isActive(oldA)).toBe(false);
    expect(coordinator.isActive(oldB)).toBe(false);
    expect(coordinator.isPending(WORKSPACE_A)).toBe(false);
    expect(coordinator.isTokenPending(TOKEN_A)).toBe(false);

    const replacement = coordinator.begin(workspaceA, 'undo', TOKEN_A)!;
    expect(replacement.epoch).toBe(1);
    coordinator.end(oldA);
    coordinator.end(oldB);
    expect(coordinator.isCurrent(replacement, workspaceA)).toBe(true);
    expect(coordinator.isTokenPending(TOKEN_A)).toBe(true);
  });

  it('invalidates all work through the same epoch boundary', () => {
    const workspace = createInboxWorkspaceIdentity(WORKSPACE_A);
    const coordinator = new InboxArchiveCoordinator();
    const old = coordinator.begin(workspace, 'undo', TOKEN_A)!;

    coordinator.invalidateAll();
    expect(coordinator.epoch).toBe(1);
    expect(coordinator.isActive(old)).toBe(false);

    const replacement = coordinator.begin(workspace, 'undo', TOKEN_A)!;
    coordinator.end(old);
    expect(coordinator.isActive(replacement)).toBe(true);
  });

  it('rejects malformed lease identities and inconsistent token ownership', () => {
    const workspace = createInboxWorkspaceIdentity(WORKSPACE_A);
    const coordinator = new InboxArchiveCoordinator();

    expect(() => coordinator.begin(workspace, 'archive', TOKEN_A)).toThrow(TypeError);
    expect(() => coordinator.begin(workspace, 'undo')).toThrow(TypeError);
    expect(() => coordinator.begin(workspace, 'undo', TOKEN_A.toUpperCase())).toThrow(TypeError);
    expect(() =>
      coordinator.begin(createInboxWorkspaceIdentity('not-a-workspace'), 'archive'),
    ).toThrow(TypeError);
    expect(() => coordinator.isTokenPending('not-a-token')).toThrow(TypeError);
    expect(() => coordinator.invalidate('not-a-workspace')).toThrow(TypeError);
  });
});
