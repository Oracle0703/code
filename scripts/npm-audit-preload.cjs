'use strict';

const { realpathSync, readFileSync, statSync } = require('node:fs');
const { createRequire } = require('node:module');
const path = require('node:path');

const { createCompatibleRegistryFetch } = require('./npm-audit-compat.cjs');

const NPM_CLI_ENV = 'DAILY_WORKBENCH_NPM_AUDIT_CLI';
const EXPECTED_VERSIONS = Object.freeze({
  npm: '11.9.0',
  'npm-registry-fetch': '19.1.1',
  '@npmcli/arborist': '9.2.0',
  'minipass-fetch': '5.0.1',
});

install();

function install() {
  const configuredNpmCli = process.env[NPM_CLI_ENV];
  delete process.env[NPM_CLI_ENV];
  if (!configuredNpmCli || !path.isAbsolute(configuredNpmCli)) {
    throw new Error(`${NPM_CLI_ENV} must contain the absolute npm CLI path.`);
  }
  if (!statSync(configuredNpmCli, { throwIfNoEntry: false })?.isFile()) {
    throw new Error(`${NPM_CLI_ENV} does not identify a file.`);
  }

  const npmCliPath = realpathSync(configuredNpmCli);
  if (!process.argv[1] || realpathSync(process.argv[1]) !== npmCliPath) {
    throw new Error('The npm audit preload may only run for its configured npm CLI.');
  }

  const npmRoot = realpathSync(path.resolve(path.dirname(npmCliPath), '..'));
  const expectedNpmCliPath = realpathSync(path.join(npmRoot, 'bin', 'npm-cli.js'));
  if (npmCliPath !== expectedNpmCliPath) {
    throw new Error('The npm audit preload requires the canonical bin/npm-cli.js entry point.');
  }
  assertPackageVersion(path.join(npmRoot, 'package.json'), 'npm');

  const npmRequire = createRequire(npmCliPath);
  const registryFetchId = realpathSync(npmRequire.resolve('npm-registry-fetch'));
  const registryFetchPackage = realpathSync(npmRequire.resolve('npm-registry-fetch/package.json'));
  const arboristAuditId = realpathSync(npmRequire.resolve('@npmcli/arborist/lib/audit-report.js'));
  const arboristPackage = realpathSync(npmRequire.resolve('@npmcli/arborist/package.json'));
  const minipassFetchId = realpathSync(npmRequire.resolve('minipass-fetch'));
  const minipassFetchPackage = realpathSync(npmRequire.resolve('minipass-fetch/package.json'));

  for (const resolvedPath of [
    registryFetchId,
    registryFetchPackage,
    arboristAuditId,
    arboristPackage,
    minipassFetchId,
    minipassFetchPackage,
  ]) {
    if (!isPathInside(npmRoot, resolvedPath)) {
      throw new Error('npm audit preload resolved a module outside the configured npm package.');
    }
  }

  assertPackageVersion(registryFetchPackage, 'npm-registry-fetch');
  assertPackageVersion(arboristPackage, '@npmcli/arborist');
  assertPackageVersion(minipassFetchPackage, 'minipass-fetch');

  for (const moduleId of [registryFetchId, arboristAuditId, minipassFetchId]) {
    if (require.cache[moduleId]) {
      throw new Error('npm audit preload found a target module cached before installation.');
    }
  }

  const originalFetch = npmRequire(registryFetchId);
  const cacheEntry = require.cache[registryFetchId];
  if (!cacheEntry || cacheEntry.exports !== originalFetch) {
    throw new Error('npm audit preload could not identify the npm-registry-fetch cache entry.');
  }

  cacheEntry.exports = createCompatibleRegistryFetch(originalFetch, {
    onCompatibility: ({ wireBytes, decodedBytes }) => {
      process.stderr.write(
        `[npm audit transport] decoded headerless gzip response (${wireBytes} compressed / ${decodedBytes} decoded bytes).\n`,
      );
    },
  });
}

function assertPackageVersion(packageJsonPath, packageName) {
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(packageJsonPath, 'utf8'));
  } catch (cause) {
    throw new Error(`Could not read the ${packageName} package manifest.`, { cause });
  }

  const expected = EXPECTED_VERSIONS[packageName];
  if (manifest?.name !== packageName || manifest?.version !== expected) {
    throw new Error(
      `npm audit compatibility requires ${packageName} ${expected}; received ${String(
        manifest?.version,
      )}.`,
    );
  }
}

function isPathInside(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}
