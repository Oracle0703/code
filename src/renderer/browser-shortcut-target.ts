interface ClosestEventTarget extends EventTarget {
  closest(selector: string): unknown;
}

export function shouldHandleBrowserShortcutTarget(
  insideBrowserPanel: boolean,
  insideTerminal: boolean,
): boolean {
  return insideBrowserPanel && !insideTerminal;
}

export function isBrowserShortcutEventTarget(target: EventTarget | null): boolean {
  if (!hasClosest(target)) return false;
  return shouldHandleBrowserShortcutTarget(
    target.closest('.browser-panel') !== null,
    target.closest('.xterm') !== null,
  );
}

function hasClosest(target: EventTarget | null): target is ClosestEventTarget {
  return target !== null && typeof (target as Partial<ClosestEventTarget>).closest === 'function';
}
