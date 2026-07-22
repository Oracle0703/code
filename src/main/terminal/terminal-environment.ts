export function createTerminalEnvironment(
  source: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
): Record<string, string> {
  const environment: Record<string, string> = {};
  for (const [key, value] of Object.entries(source)) {
    if (typeof value === 'string') {
      environment[key] = value;
    }
  }

  if (platform === 'win32') {
    const systemRoot = environment.SystemRoot || environment.WINDIR || 'C:\\Windows';
    environment.SystemRoot ||= systemRoot;
    environment.WINDIR ||= systemRoot;
  }

  environment.TERM = 'xterm-256color';
  environment.COLORTERM = 'truecolor';
  environment.TERM_PROGRAM = 'DailyWorkbench';
  return environment;
}
