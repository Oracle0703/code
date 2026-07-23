export interface BrowserShortcutInput {
  readonly type: string;
  readonly key: string;
  readonly control: boolean;
  readonly meta: boolean;
  readonly alt: boolean;
  readonly shift: boolean;
  readonly repeat: boolean;
  readonly composing: boolean;
}

export type BrowserShortcutAction =
  | 'focus-address'
  | 'create-tab'
  | 'close-tab'
  | 'reload'
  | 'toggle-bookmark'
  | 'next-tab'
  | 'previous-tab'
  | 'back'
  | 'forward'
  | 'stop';

export function getBrowserShortcutAction(
  input: BrowserShortcutInput,
): BrowserShortcutAction | null {
  if (input.type.toLowerCase() !== 'keydown' || input.repeat || input.composing) {
    return null;
  }

  const key = input.key.toLowerCase();
  if (input.control && input.meta) return null;
  const primary = input.control || input.meta;

  if (primary && !input.alt) {
    if (key === 'tab') {
      if (!input.control || input.meta) return null;
      return input.shift ? 'previous-tab' : 'next-tab';
    }
    if (input.shift) return null;
    switch (key) {
      case 'l':
        return 'focus-address';
      case 't':
        return 'create-tab';
      case 'w':
        return 'close-tab';
      case 'r':
        return 'reload';
      case 'd':
        return 'toggle-bookmark';
      default:
        return null;
    }
  }

  if (input.alt && !primary && !input.shift) {
    if (key === 'arrowleft') return 'back';
    if (key === 'arrowright') return 'forward';
    return null;
  }

  return !primary && !input.alt && !input.shift && key === 'escape' ? 'stop' : null;
}
