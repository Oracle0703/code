import { describe, expect, it } from 'vitest';
import { createTerminalEnvironment } from '../src/main/terminal/terminal-environment';

describe('terminal environment', () => {
  it('injects both Windows root variables when only WINDIR is available', () => {
    const environment = createTerminalEnvironment({ WINDIR: 'D:\\Windows' }, 'win32');

    expect(environment.SystemRoot).toBe('D:\\Windows');
    expect(environment.WINDIR).toBe('D:\\Windows');
  });

  it('falls back to the standard Windows root when both variables are absent', () => {
    const environment = createTerminalEnvironment({}, 'win32');

    expect(environment.SystemRoot).toBe('C:\\Windows');
    expect(environment.WINDIR).toBe('C:\\Windows');
  });

  it('preserves source values and adds terminal capability variables', () => {
    const source = { PATH: '/usr/bin', TERM: 'legacy' };
    const environment = createTerminalEnvironment(source, 'linux');

    expect(environment).toMatchObject({
      PATH: '/usr/bin',
      TERM: 'xterm-256color',
      COLORTERM: 'truecolor',
      TERM_PROGRAM: 'DailyWorkbench',
    });
    expect(source).toEqual({ PATH: '/usr/bin', TERM: 'legacy' });
    expect(environment.SystemRoot).toBeUndefined();
  });
});
