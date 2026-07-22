import { stat } from 'node:fs/promises';
import path from 'node:path';
import { getCurrentFuseWire } from '@electron/fuses';

const executableArgument = process.argv[2];
if (!executableArgument) {
  throw new Error(
    'Usage: node scripts/verify-packaged-app.mjs <packaged-executable> [max-asar-mib]',
  );
}

const maxAsarMiB = Number(process.argv[3] ?? '70');
if (!Number.isFinite(maxAsarMiB) || maxAsarMiB <= 0) {
  throw new Error(`Invalid app.asar size limit: ${String(process.argv[3])}`);
}

const executablePath = path.resolve(executableArgument);
const resourcesPath = getResourcesPath(executablePath);
const asarPath = path.join(resourcesPath, 'app.asar');
const [executableStats, asarStats, fuseWire] = await Promise.all([
  stat(executablePath),
  stat(asarPath),
  getCurrentFuseWire(executablePath),
]);

if (!executableStats.isFile() || !asarStats.isFile()) {
  throw new Error('Packaged executable or app.asar is not a regular file.');
}

const expectedFuses = [
  ['RunAsNode', 49],
  ['EnableCookieEncryption', 49],
  ['EnableNodeOptionsEnvironmentVariable', 48],
  ['EnableNodeCliInspectArguments', 48],
  ['EnableEmbeddedAsarIntegrityValidation', 49],
  ['OnlyLoadAppFromAsar', 49],
  ['LoadBrowserProcessSpecificV8Snapshot', 48],
  ['GrantFileProtocolExtraPrivileges', 49],
  ['WasmTrapHandlers', 49],
];

if (fuseWire.version !== '1') {
  throw new Error(`Expected Electron fuse wire version 1, received ${fuseWire.version}.`);
}

const numericFuseKeys = Object.keys(fuseWire).filter((key) => /^\d+$/.test(key));
if (numericFuseKeys.length !== expectedFuses.length) {
  throw new Error(
    `Expected exactly ${expectedFuses.length} Electron fuses, received ${numericFuseKeys.length}. Review new Electron fuse defaults before updating this assertion.`,
  );
}

for (const [index, [name, expectedState]] of expectedFuses.entries()) {
  const actualState = fuseWire[index];
  if (actualState !== expectedState) {
    throw new Error(
      `${name} fuse at index ${index} expected ${formatFuseState(expectedState)}, received ${formatFuseState(actualState)}.`,
    );
  }
}

const maxAsarBytes = maxAsarMiB * 1024 * 1024;
if (asarStats.size > maxAsarBytes) {
  throw new Error(
    `app.asar is ${(asarStats.size / 1024 / 1024).toFixed(1)} MiB, above the ${maxAsarMiB} MiB baseline limit.`,
  );
}

console.log(
  `Packaged app verified: ${expectedFuses.length} explicit fuse states, app.asar ${(asarStats.size / 1024 / 1024).toFixed(1)} MiB (limit ${maxAsarMiB} MiB).`,
);

function getResourcesPath(executable) {
  const marker = `${path.sep}Contents${path.sep}MacOS${path.sep}`;
  if (executable.includes(marker)) {
    return path.resolve(path.dirname(executable), '..', 'Resources');
  }
  return path.join(path.dirname(executable), 'resources');
}

function formatFuseState(value) {
  if (value === 49) return 'enabled';
  if (value === 48) return 'disabled';
  if (value === 114) return 'removed';
  if (value === 144) return 'inherited';
  return `unknown (${String(value)})`;
}
