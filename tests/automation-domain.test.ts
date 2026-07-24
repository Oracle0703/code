import { describe, expect, it } from 'vitest';
import {
  formatAutomationMinute,
  normalizeAutomationAction,
  normalizeAutomationActionKind,
  normalizeAutomationCadence,
  normalizeAutomationId,
  normalizeAutomationName,
  normalizeAutomationRevision,
  normalizeAutomationSchedule,
} from '../src/shared/automation-domain';

describe('automation domain', () => {
  it('normalizes names, identifiers, cadence, revisions, and display time', () => {
    expect(normalizeAutomationId('123e4567-e89b-42d3-a456-426614174000')).toBe(
      '123e4567-e89b-42d3-a456-426614174000',
    );
    expect(normalizeAutomationName('  每日准备  ')).toBe('每日准备');
    expect(normalizeAutomationCadence('daily')).toBe('daily');
    expect(normalizeAutomationActionKind('create-note')).toBe('create-note');
    expect(normalizeAutomationRevision(3)).toBe(3);
    expect(formatAutomationMinute(510)).toBe('08:30');
  });

  it('requires cadence-specific weekday fields and bounded local minutes', () => {
    expect(
      normalizeAutomationSchedule({ cadence: 'daily', localTimeMinute: 510, weekday: null }),
    ).toEqual({ cadence: 'daily', localTimeMinute: 510, weekday: null });
    expect(
      normalizeAutomationSchedule({ cadence: 'weekly', localTimeMinute: 1_050, weekday: 5 }),
    ).toEqual({ cadence: 'weekly', localTimeMinute: 1_050, weekday: 5 });

    expect(() =>
      normalizeAutomationSchedule({ cadence: 'daily', localTimeMinute: 510, weekday: 1 }),
    ).toThrow(/weekday/u);
    expect(() =>
      normalizeAutomationSchedule({ cadence: 'weekly', localTimeMinute: 1_440, weekday: null }),
    ).toThrow();
  });

  it('normalizes only the fixed task and note action payloads', () => {
    expect(normalizeAutomationAction({ kind: 'create-today-task', title: '  检查备份  ' })).toEqual(
      {
        kind: 'create-today-task',
        title: '检查备份',
      },
    );
    expect(
      normalizeAutomationAction({
        kind: 'create-note',
        title: ' 周回顾 ',
        body: '第一行\r\n第二行',
      }),
    ).toEqual({
      kind: 'create-note',
      title: '周回顾',
      body: '第一行\n第二行',
    });
    expect(() => normalizeAutomationAction({ kind: 'run-command', title: 'whoami' })).toThrow(
      /action/u,
    );
  });

  it('rejects malformed or unsupported public values', () => {
    expect(() => normalizeAutomationId('123E4567-E89B-42D3-A456-426614174000')).toThrow();
    expect(() => normalizeAutomationName('\u202e')).toThrow();
    expect(() => normalizeAutomationName('x'.repeat(121))).toThrow();
    expect(() => normalizeAutomationRevision(0)).toThrow();
  });
});
