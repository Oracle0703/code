import { spawnSync } from 'node:child_process';
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const reportDirectory = path.join(projectRoot, 'reports');
const reportPath = path.join(reportDirectory, 'npm-audit.json');
const allowlistPath = path.join(projectRoot, 'config', 'audit-allowlist.json');
const lockfilePath = path.join(projectRoot, 'package-lock.json');

await mkdir(reportDirectory, { recursive: true });

const npmExecutable = process.env.npm_execpath;
const command = npmExecutable ? process.execPath : process.platform === 'win32' ? 'npm.cmd' : 'npm';
const args = npmExecutable ? [npmExecutable, 'audit', '--json'] : ['audit', '--json'];
const auditRun = spawnSync(command, args, {
  cwd: projectRoot,
  encoding: 'utf8',
  env: process.env,
  maxBuffer: 20 * 1024 * 1024,
  shell: !npmExecutable && process.platform === 'win32',
});

if (auditRun.stderr) {
  process.stderr.write(auditRun.stderr);
}

const rawReport = auditRun.stdout.trim();
if (!rawReport) {
  throw new Error(`npm audit did not return JSON (exit ${auditRun.status ?? 'unknown'}).`);
}

await writeFile(reportPath, `${rawReport}\n`, 'utf8');

let report;
try {
  report = JSON.parse(rawReport);
} catch (error) {
  throw new Error(`Could not parse npm audit output saved at ${reportPath}.`, { cause: error });
}

if (report.error) {
  throw new Error(`npm audit failed: ${report.error.summary ?? JSON.stringify(report.error)}`);
}

validateAuditReport(report);

if (![0, 1].includes(auditRun.status)) {
  throw new Error(`npm audit exited unexpectedly with status ${auditRun.status ?? 'unknown'}.`);
}

const [allowlist, lockfile] = await Promise.all([readJson(allowlistPath), readJson(lockfilePath)]);

if (!isRecord(allowlist) || allowlist.schemaVersion !== 1 || !Array.isArray(allowlist.exceptions)) {
  throw new Error('Unsupported or invalid dependency audit allowlist.');
}
if (!isRecord(lockfile) || !isRecord(lockfile.packages)) {
  throw new Error('package-lock.json is missing its package metadata map.');
}

const allowedAdvisories = new Map();
for (const exception of allowlist.exceptions) {
  validateAllowlistException(exception);
  for (const advisoryId of exception.advisoryIds) {
    const normalizedAdvisoryId = advisoryId.toUpperCase();
    if (allowedAdvisories.has(normalizedAdvisoryId)) {
      throw new Error(`Duplicate audit allowlist entry: ${advisoryId}`);
    }
    allowedAdvisories.set(normalizedAdvisoryId, exception);
  }
}

const vulnerabilities = report.vulnerabilities;
const actualAdvisories = [];
for (const [dependencyName, vulnerability] of Object.entries(vulnerabilities)) {
  validateVulnerability(dependencyName, vulnerability);
  for (const via of vulnerability.via) {
    if (via && typeof via === 'object') {
      const advisoryId = getAdvisoryId(via);
      actualAdvisories.push({
        id: advisoryId,
        package: via.name ?? dependencyName,
        severity: via.severity ?? vulnerability.severity,
        title: via.title ?? 'Untitled advisory',
        url: via.url,
      });
    }
  }
}

const failures = [];
const today = new Date().toISOString().slice(0, 10);

for (const advisory of actualAdvisories) {
  const exception = allowedAdvisories.get(advisory.id);
  if (!exception) {
    failures.push(
      `Unreviewed advisory ${advisory.id} affects ${advisory.package}: ${advisory.title}`,
    );
    continue;
  }
  if (exception.package !== advisory.package) {
    failures.push(
      `${advisory.id} moved from allowlisted package ${exception.package} to ${advisory.package}`,
    );
  }
  if (exception.expiresOn < today) {
    failures.push(`${advisory.id} exception expired on ${exception.expiresOn}`);
  }
}

for (const [dependencyName, vulnerability] of Object.entries(vulnerabilities)) {
  const advisoryIds = resolveAdvisoryIds(dependencyName, vulnerabilities, new Set());
  if (advisoryIds.size === 0) {
    failures.push(`Could not resolve a root advisory for vulnerable dependency ${dependencyName}`);
  }

  for (const nodePath of vulnerability.nodes) {
    const lockEntry = lockfile.packages?.[nodePath];
    if (!lockEntry?.dev) {
      failures.push(
        `${dependencyName} is allowlisted only for development use, but ${nodePath} is not marked dev-only`,
      );
    }
  }
}

const counts = report.metadata.vulnerabilities;
const actualAdvisoryIds = new Set(actualAdvisories.map((advisory) => advisory.id));
const activeAllowlisted = [...actualAdvisoryIds].filter((id) => allowedAdvisories.has(id));
const resolvedAllowlisted = [...allowedAdvisories.keys()].filter(
  (id) => !actualAdvisoryIds.has(id),
);
const summary = [
  '## Full dependency audit',
  '',
  `- Affected dependency nodes: ${counts.total ?? 0}`,
  `- Severity: ${counts.critical ?? 0} critical / ${counts.high ?? 0} high / ${counts.moderate ?? 0} moderate / ${counts.low ?? 0} low`,
  `- Reviewed build-time advisories: ${activeAllowlisted.length}`,
  `- Resolved allowlisted advisories: ${resolvedAllowlisted.length}`,
  `- Report: ${path.relative(projectRoot, reportPath)}`,
  '',
].join('\n');

process.stdout.write(summary);
if (process.env.GITHUB_STEP_SUMMARY) {
  await appendFile(process.env.GITHUB_STEP_SUMMARY, summary, 'utf8');
}

if (failures.length > 0) {
  for (const failure of [...new Set(failures)]) {
    console.error(`- ${failure}`);
  }
  process.exitCode = 1;
} else {
  console.log('Dependency audit matches the reviewed, development-only risk baseline.');
}

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, 'utf8'));
}

function validateAuditReport(value) {
  if (!isRecord(value) || value.auditReportVersion !== 2) {
    throw new Error(`Unsupported npm audit schema version: ${String(value?.auditReportVersion)}`);
  }
  if (!isRecord(value.vulnerabilities) || !isRecord(value.metadata?.vulnerabilities)) {
    throw new Error('npm audit report is missing the v2 vulnerability maps.');
  }

  const severityNames = ['info', 'low', 'moderate', 'high', 'critical'];
  for (const severity of [...severityNames, 'total']) {
    const count = value.metadata.vulnerabilities[severity];
    if (!Number.isInteger(count) || count < 0) {
      throw new Error(`npm audit returned an invalid ${severity} vulnerability count.`);
    }
  }

  const severityTotal = severityNames.reduce(
    (total, severity) => total + value.metadata.vulnerabilities[severity],
    0,
  );
  if (severityTotal !== value.metadata.vulnerabilities.total) {
    throw new Error('npm audit vulnerability counts do not add up to the reported total.');
  }
}

function validateAllowlistException(exception) {
  if (
    !isRecord(exception) ||
    typeof exception.package !== 'string' ||
    exception.package.length === 0 ||
    !Array.isArray(exception.advisoryIds) ||
    exception.advisoryIds.length === 0 ||
    !exception.advisoryIds.every((id) => typeof id === 'string' && /^GHSA-[a-z0-9-]+$/i.test(id)) ||
    typeof exception.scope !== 'string' ||
    exception.scope.length === 0 ||
    typeof exception.rationale !== 'string' ||
    exception.rationale.length === 0 ||
    !isIsoDate(exception.expiresOn)
  ) {
    throw new Error('Dependency audit allowlist contains an invalid exception.');
  }
}

function validateVulnerability(dependencyName, vulnerability) {
  if (
    !isRecord(vulnerability) ||
    !Array.isArray(vulnerability.via) ||
    !Array.isArray(vulnerability.nodes) ||
    vulnerability.nodes.length === 0 ||
    !vulnerability.nodes.every((nodePath) => typeof nodePath === 'string' && nodePath.length > 0)
  ) {
    throw new Error(`npm audit returned an invalid vulnerability entry for ${dependencyName}.`);
  }
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isIsoDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === value;
}

function getAdvisoryId(advisory) {
  if (typeof advisory.url === 'string') {
    const match = advisory.url.match(/(GHSA-[a-z0-9-]+)$/i);
    if (match) return match[1].toUpperCase();
  }
  return `NPM-${advisory.source ?? 'UNKNOWN'}`;
}

function resolveAdvisoryIds(dependencyName, allVulnerabilities, seen) {
  if (seen.has(dependencyName)) return new Set();
  seen.add(dependencyName);

  const ids = new Set();
  const vulnerability = allVulnerabilities[dependencyName];
  for (const via of vulnerability.via) {
    if (typeof via === 'string') {
      for (const id of resolveAdvisoryIds(via, allVulnerabilities, seen)) ids.add(id);
    } else if (via && typeof via === 'object') {
      ids.add(getAdvisoryId(via));
    }
  }
  return ids;
}
