import { describe, expect, it } from 'vitest';
import { isQuickCaptureShortcut } from '../src/shared/quick-capture-shortcut';

const validInput = {
  type: 'keyDown',
  key: 'n',
  control: true,
  meta: false,
  alt: false,
  shift: false,
  repeat: false,
  composing: false,
} as const;

describe('quick-capture shortcut', () => {
  it('accepts Ctrl+N and Cmd+N keydown events', () => {
    expect(isQuickCaptureShortcut(validInput)).toBe(true);
    expect(isQuickCaptureShortcut({ ...validInput, key: 'N', control: false, meta: true })).toBe(
      true,
    );
  });

  it.each([
    ['keyup', { type: 'keyUp' }],
    ['wrong key', { key: 'm' }],
    ['missing command modifier', { control: false }],
    ['Alt modifier', { alt: true }],
    ['Shift modifier', { shift: true }],
    ['auto-repeat', { repeat: true }],
    ['IME composition', { composing: true }],
  ])('rejects %s', (_label, override) => {
    expect(isQuickCaptureShortcut({ ...validInput, ...override })).toBe(false);
  });
});
