import { spawnSync } from 'node:child_process';
import { statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const NPM_CLI_ENV = 'DAILY_WORKBENCH_NPM_AUDIT_CLI';
const profiles = Object.freeze({
  full: ['--json', '--no-update-notifier'],
  production: ['--omit=dev', '--audit-level=info', '--no-update-notifier'],
});

const requestedProfile = process.argv[2];
if (process.argv.length !== 3 || !Object.hasOwn(profiles, requestedProfile)) {
  throw new Error('npm audit runner requires exactly one profile: full or production.');
}

const configuredNpmCli = process.env.npm_execpath;
if (!configuredNpmCli || !path.isAbsolute(configuredNpmCli)) {
  throw new Error('npm_execpath must contain the absolute npm CLI path.');
}
if (!statSync(configuredNpmCli, { throwIfNoEntry: false })?.isFile()) {
  throw new Error('npm_execpath does not identify a file.');
}

const preloadPath = fileURLToPath(new URL('./npm-audit-preload.cjs', import.meta.url));
const auditRun = spawnSync(
  process.execPath,
  ['--require', preloadPath, configuredNpmCli, 'audit', ...profiles[requestedProfile]],
  {
    cwd: process.cwd(),
    env: {
      ...process.env,
      [NPM_CLI_ENV]: configuredNpmCli,
    },
    shell: false,
    stdio: 'inherit',
  },
);

if (auditRun.error) throw auditRun.error;
if (auditRun.signal) {
  throw new Error(`npm audit was terminated by signal ${auditRun.signal}.`);
}
if (!Number.isInteger(auditRun.status)) {
  throw new Error('npm audit did not return an exit status.');
}

process.exitCode = auditRun.status;
