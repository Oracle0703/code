import { describe, expect, it } from 'vitest';
import {
  FOCUS_DURATION_SECONDS,
  focusDeadlineAt,
  focusRemainingAt,
  normalizeFocusRemainingSeconds,
  normalizeFocusRevision,
  normalizeFocusSessionId,
  normalizeFocusState,
  normalizeFocusTimestamp,
} from '../src/shared/focus-domain';

const SESSION_ID = 'a1111111-1111-4111-8111-111111111111';
const START = new Date('2026-07-23T08:00:00.000Z');

describe('focus domain', () => {
  it('creates a fixed twenty-five minute absolute deadline', () => {
    expect(FOCUS_DURATION_SECONDS).toBe(1_500);
    expect(focusDeadlineAt(START, FOCUS_DURATION_SECONDS)).toBe('2026-07-23T08:25:00.000Z');
  });

  it('rounds a partial final second up and never exceeds the persisted upper bound', () => {
    const deadline = '2026-07-23T08:00:10.001Z';
    expect(focusRemainingAt(10, deadline, START)).toBe(10);
    expect(focusRemainingAt(10, deadline, new Date('2026-07-23T08:00:09.002Z'))).toBe(1);
    expect(focusRemainingAt(10, deadline, new Date('2026-07-23T08:00:10.001Z'))).toBe(0);
    expect(
      focusRemainingAt(7, '2026-07-23T09:00:00.000Z', new Date('2026-07-23T08:00:00.000Z')),
    ).toBe(7);
  });

  it('accepts only canonical ids, states, revisions, remaining values, and timestamps', () => {
    expect(normalizeFocusSessionId(SESSION_ID)).toBe(SESSION_ID);
    expect(normalizeFocusState('paused')).toBe('paused');
    expect(normalizeFocusRevision(1)).toBe(1);
    expect(normalizeFocusRemainingSeconds(0)).toBe(0);
    expect(normalizeFocusRemainingSeconds(1, false)).toBe(1);
    expect(normalizeFocusTimestamp(START.toISOString())).toBe(START.toISOString());

    expect(() => normalizeFocusSessionId(SESSION_ID.toUpperCase())).toThrow();
    expect(() => normalizeFocusState('open')).toThrow();
    expect(() => normalizeFocusRevision(0)).toThrow();
    expect(() => normalizeFocusRemainingSeconds(0, false)).toThrow();
    expect(() => normalizeFocusRemainingSeconds(1_501)).toThrow();
    expect(() => normalizeFocusTimestamp('2026-07-23T08:00:00Z')).toThrow();
  });

  it('rejects invalid clocks and deadlines', () => {
    expect(() => focusDeadlineAt(new Date(Number.NaN), 1)).toThrow(/clock/u);
    expect(() => focusDeadlineAt(START, 0)).toThrow(/remaining/u);
    expect(() => focusRemainingAt(1, 'not-a-date', START)).toThrow(/deadline/u);
    expect(() => focusRemainingAt(1, START.toISOString(), new Date(Number.NaN))).toThrow(/clock/u);
  });
});
