import { describe, expect, it } from 'vitest';
import {
  assertNoArguments,
  parseBoolean,
  parseBrowserBounds,
  parseSessionId,
  parseTerminalCreateOptions,
  parseTerminalSize,
  parseWorkspaceCreateInput,
  parseWorkspacePreferencesInput,
  parseWorkspaceRenameInput,
  parseWorkspaceTargetInput,
} from '../src/main/ipc/validation';
import { WORKSPACE_COLORS } from '../src/shared/contracts';

const WORKSPACE_ID = '123e4567-e89b-42d3-a456-426614174000';

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

  it('accepts supported terminal profiles and safe sizes', () => {
    expect(parseTerminalCreateOptions({ cwd: 'C:\\work', shell: 'powershell' })).toEqual({
      cwd: 'C:\\work',
      shell: 'powershell',
    });
    expect(parseTerminalSize(120, 32)).toEqual({ columns: 120, rows: 32 });
  });

  it('rejects unsupported profiles and terminal dimensions', () => {
    expect(() => parseTerminalCreateOptions({ shell: 'fish' })).toThrow(TypeError);
    expect(() => parseTerminalSize(0, 32)).toThrow(TypeError);
    expect(() => parseTerminalSize(120, 1_001)).toThrow(TypeError);
  });

  it('accepts only UUID v4 terminal session identifiers', () => {
    expect(parseSessionId('123e4567-e89b-42d3-a456-426614174000')).toBe(
      '123e4567-e89b-42d3-a456-426614174000',
    );
    expect(() => parseSessionId('../../another-session')).toThrow(TypeError);
  });

  it('does not coerce boolean values', () => {
    expect(parseBoolean(true, 'visible')).toBe(true);
    expect(() => parseBoolean('true', 'visible')).toThrow(TypeError);
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
});
