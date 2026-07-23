import { describe, expect, it } from 'vitest';
import {
  isBrowserShortcutEventTarget,
  shouldHandleBrowserShortcutTarget,
} from '../src/renderer/browser-shortcut-target';

describe('browser Renderer shortcut target scope', () => {
  it.each([
    [true, false, true],
    [true, true, false],
    [false, false, false],
    [false, true, false],
  ])(
    'handles only browser-panel targets outside xterm (%s, %s)',
    (insideBrowserPanel, insideTerminal, expected) => {
      expect(shouldHandleBrowserShortcutTarget(insideBrowserPanel, insideTerminal)).toBe(expected);
    },
  );

  it('accepts browser chrome while rejecting xterm and external editable DOM targets', () => {
    expect(isBrowserShortcutEventTarget(target('.browser-panel'))).toBe(true);
    expect(isBrowserShortcutEventTarget(target('.browser-panel', 'input'))).toBe(true);
    expect(isBrowserShortcutEventTarget(target('.browser-panel', '.xterm'))).toBe(false);

    for (const editableSelector of ['input', 'textarea', 'select', '[contenteditable=true]']) {
      expect(isBrowserShortcutEventTarget(target(editableSelector))).toBe(false);
    }
    expect(isBrowserShortcutEventTarget(null)).toBe(false);
  });
});

function target(...matchingSelectors: string[]): EventTarget {
  const matches = new Set(matchingSelectors);
  return {
    closest: (selector: string) => (matches.has(selector) ? { selector } : null),
  } as unknown as EventTarget;
}
