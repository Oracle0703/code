export interface QuickCaptureShortcutInput {
  readonly type: string;
  readonly key: string;
  readonly control: boolean;
  readonly meta: boolean;
  readonly alt: boolean;
  readonly shift: boolean;
  readonly repeat: boolean;
  readonly composing: boolean;
}

export function isQuickCaptureShortcut(input: QuickCaptureShortcutInput): boolean {
  return (
    input.type === 'keyDown' &&
    input.key.toLowerCase() === 'n' &&
    (input.control || input.meta) &&
    !input.alt &&
    !input.shift &&
    !input.repeat &&
    !input.composing
  );
}
