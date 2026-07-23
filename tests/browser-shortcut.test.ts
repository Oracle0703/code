import { describe, expect, it } from 'vitest';
import {
  getBrowserShortcutAction,
  type BrowserShortcutInput,
} from '../src/shared/browser-shortcut';

const BASE_INPUT: BrowserShortcutInput = {
  type: 'keyDown',
  key: '',
  control: false,
  meta: false,
  alt: false,
  shift: false,
  repeat: false,
  composing: false,
};

describe('getBrowserShortcutAction', () => {
  it.each([
    ['l', 'focus-address'],
    ['t', 'create-tab'],
    ['w', 'close-tab'],
    ['r', 'reload'],
    ['d', 'toggle-bookmark'],
  ] as const)('maps Ctrl/Cmd+%s to %s', (key, action) => {
    expect(getBrowserShortcutAction({ ...BASE_INPUT, key, control: true })).toBe(action);
    expect(getBrowserShortcutAction({ ...BASE_INPUT, key, meta: true })).toBe(action);
  });

  it('supports forward and reverse tab cycling for Electron and DOM event names', () => {
    expect(
      getBrowserShortcutAction({ ...BASE_INPUT, type: 'keydown', key: 'Tab', control: true }),
    ).toBe('next-tab');
    expect(
      getBrowserShortcutAction({
        ...BASE_INPUT,
        key: 'Tab',
        control: true,
        shift: true,
      }),
    ).toBe('previous-tab');
    expect(getBrowserShortcutAction({ ...BASE_INPUT, key: 'Tab', meta: true })).toBeNull();
  });

  it('supports browser history and loading cancellation shortcuts', () => {
    expect(getBrowserShortcutAction({ ...BASE_INPUT, key: 'ArrowLeft', alt: true })).toBe('back');
    expect(getBrowserShortcutAction({ ...BASE_INPUT, key: 'ArrowRight', alt: true })).toBe(
      'forward',
    );
    expect(getBrowserShortcutAction({ ...BASE_INPUT, key: 'Escape' })).toBe('stop');
  });

  it.each([
    { ...BASE_INPUT, type: 'keyUp', key: 'l', control: true },
    { ...BASE_INPUT, type: 'keyup', key: 'l', control: true },
    { ...BASE_INPUT, key: 'l', control: true, repeat: true },
    { ...BASE_INPUT, key: 'l', control: true, composing: true },
    { ...BASE_INPUT, key: 'l', control: true, alt: true },
    { ...BASE_INPUT, key: 'd', control: true, shift: true },
    { ...BASE_INPUT, key: 'l', control: true, meta: true },
    { ...BASE_INPUT, key: 't', control: true, meta: true },
    { ...BASE_INPUT, key: 'w', control: true, meta: true },
    { ...BASE_INPUT, key: 'r', control: true, meta: true },
    { ...BASE_INPUT, key: 'd', control: true, meta: true },
    { ...BASE_INPUT, key: 'ArrowLeft', alt: true, control: true },
    { ...BASE_INPUT, key: 'Escape', shift: true },
  ])('rejects release, repetition, composition, or conflicting modifiers', (input) => {
    expect(getBrowserShortcutAction(input)).toBeNull();
  });
});
