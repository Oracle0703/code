import { describe, expect, it } from 'vitest';
import { WorkspaceArchiveRequestGate } from '../src/renderer/workspace-archive-state';

const WORKSPACE_ID = '11111111-1111-4111-8111-111111111111';

describe('workspace archive request gate', () => {
  it('deduplicates an open load and rejects its response after the surface closes', () => {
    const gate = new WorkspaceArchiveRequestGate();

    expect(gate.beginLoad()).toBeNull();
    const firstOpen = gate.open();
    const duplicateOpen = gate.open();
    const load = gate.beginLoad();

    expect(firstOpen.opened).toBe(true);
    expect(duplicateOpen).toEqual({ session: firstOpen.session, opened: false });
    expect(load).not.toBeNull();
    expect(gate.beginLoad()).toBeNull();
    expect(gate.close()).toBe(true);
    expect(gate.finishLoad(load!)).toBe(false);

    const reopened = gate.open();
    const freshLoad = gate.beginLoad();
    expect(reopened.session).toBeGreaterThan(firstOpen.session);
    expect(freshLoad).not.toBeNull();
    expect(gate.finishLoad(freshLoad!)).toBe(true);
  });

  it('keeps a restore exclusive and prevents dismissal until it settles', () => {
    const gate = new WorkspaceArchiveRequestGate();
    gate.open();
    const load = gate.beginLoad();
    expect(load).not.toBeNull();
    expect(gate.finishLoad(load!)).toBe(true);

    const restore = gate.beginRestore(WORKSPACE_ID);
    expect(restore).not.toBeNull();
    expect(gate.beginRestore(WORKSPACE_ID)).toBeNull();
    expect(gate.beginLoad()).toBeNull();
    expect(gate.close()).toBe(false);
    expect(gate.finishRestore(restore!)).toBe(true);
    expect(gate.close()).toBe(true);
  });

  it('drops a restore completion after the controller is disposed', () => {
    const gate = new WorkspaceArchiveRequestGate();
    gate.open();
    const restore = gate.beginRestore(WORKSPACE_ID);
    expect(restore).not.toBeNull();

    gate.dispose();

    expect(gate.finishRestore(restore!)).toBe(false);
    expect(gate.isOpen()).toBe(false);
  });
});
