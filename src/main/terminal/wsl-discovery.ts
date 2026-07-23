import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import type { TerminalWslCapabilityStatus, TerminalWslDistribution } from '../../shared/contracts';
import { normalizeWslDistributionName } from '../../shared/terminal-domain';

const WSL_PROBE_TIMEOUT_MS = 3_000;
const WSL_PROBE_MAX_BYTES = 64 * 1024;
const MAX_WSL_DISTRIBUTIONS = 64;

export interface DiscoveredWslDistribution extends TerminalWslDistribution {
  readonly name: string;
}

export interface WslDiscoverySnapshot {
  readonly status: TerminalWslCapabilityStatus;
  readonly capabilityRevision: number;
  readonly executable?: string;
  readonly distributions: readonly DiscoveredWslDistribution[];
}

export interface WslDiscoveryLike {
  getSnapshot(): Promise<WslDiscoverySnapshot>;
  refresh(): Promise<WslDiscoverySnapshot>;
  stop(): void;
}

export interface WslDiscoveryOptions {
  readonly platform?: NodeJS.Platform;
  readonly resolveExecutable: () => string | undefined;
  readonly runList?: (executable: string, signal: AbortSignal) => Promise<Buffer>;
}

export class WslDiscovery implements WslDiscoveryLike {
  readonly #platform: NodeJS.Platform;
  readonly #resolveExecutable: () => string | undefined;
  readonly #runList: (executable: string, signal: AbortSignal) => Promise<Buffer>;
  #snapshot: WslDiscoverySnapshot | null = null;
  #inFlight: Promise<WslDiscoverySnapshot> | null = null;
  #abortController: AbortController | null = null;
  #nextRevision = 1;
  #accepting = true;

  public constructor({
    platform = process.platform,
    resolveExecutable,
    runList = runWslList,
  }: WslDiscoveryOptions) {
    this.#platform = platform;
    this.#resolveExecutable = resolveExecutable;
    this.#runList = runList;
  }

  public getSnapshot(): Promise<WslDiscoverySnapshot> {
    if (!this.#accepting) {
      return Promise.reject(new Error('WSL capability discovery is shutting down'));
    }
    if (this.#snapshot) return Promise.resolve(this.#snapshot);
    return this.#startDiscovery();
  }

  public refresh(): Promise<WslDiscoverySnapshot> {
    if (!this.#accepting) {
      return Promise.reject(new Error('WSL capability discovery is shutting down'));
    }
    return this.#startDiscovery();
  }

  public stop(): void {
    if (!this.#accepting) return;
    this.#accepting = false;
    this.#abortController?.abort();
  }

  #startDiscovery(): Promise<WslDiscoverySnapshot> {
    if (this.#inFlight) return this.#inFlight;
    const revision = this.#nextRevision;
    this.#nextRevision += 1;
    const controller = new AbortController();
    this.#abortController = controller;
    const operation = this.#discover(revision, controller.signal)
      .then((snapshot) => {
        if (!this.#accepting) {
          throw new Error('WSL capability discovery is shutting down');
        }
        this.#snapshot = snapshot;
        return snapshot;
      })
      .finally(() => {
        if (this.#inFlight === operation) this.#inFlight = null;
        if (this.#abortController === controller) this.#abortController = null;
      });
    this.#inFlight = operation;
    return operation;
  }

  async #discover(revision: number, signal: AbortSignal): Promise<WslDiscoverySnapshot> {
    if (this.#platform !== 'win32') {
      return frozenSnapshot('unsupported', revision);
    }
    const executable = this.#resolveExecutable();
    if (!executable) {
      return frozenSnapshot('not-installed', revision);
    }

    try {
      const stdout = await this.#runList(executable, signal);
      if (signal.aborted) throw new Error('WSL capability discovery was cancelled');
      const names = decodeWslDistributionNames(stdout);
      if (names.length === 0) {
        return frozenSnapshot('no-distributions', revision, executable);
      }
      const distributions = names.map((name) =>
        Object.freeze({
          id: createWslDistributionId(revision, name),
          label: name,
          name,
        }),
      );
      return frozenSnapshot('ready', revision, executable, distributions);
    } catch {
      if (signal.aborted || !this.#accepting) {
        throw new Error('WSL capability discovery is shutting down');
      }
      return frozenSnapshot('probe-error', revision, executable);
    }
  }
}

export function decodeWslDistributionNames(stdout: Buffer): readonly string[] {
  if (stdout.byteLength > WSL_PROBE_MAX_BYTES) {
    throw new TypeError('WSL distribution output is too large.');
  }
  const decoded = decodeWslOutput(stdout).replace(/^\uFEFF/u, '');
  const lines = decoded.split(/\r?\n/u);
  while (lines.at(-1) === '') lines.pop();

  const names: string[] = [];
  const normalizedNames = new Set<string>();
  for (const line of lines) {
    if (line.length === 0) continue;
    const name = normalizeWslDistributionName(line);
    const normalizedName = name.toLowerCase();
    if (normalizedNames.has(normalizedName)) {
      throw new TypeError('WSL distribution output contains duplicate names.');
    }
    normalizedNames.add(normalizedName);
    names.push(name);
    if (names.length > MAX_WSL_DISTRIBUTIONS) {
      throw new TypeError('WSL distribution output contains too many entries.');
    }
  }
  return Object.freeze(names);
}

function decodeWslOutput(stdout: Buffer): string {
  if (stdout.byteLength === 0) return '';
  if (stdout[0] === 0xff && stdout[1] === 0xfe) {
    return new TextDecoder('utf-16le', { fatal: true }).decode(stdout.subarray(2));
  }
  if (stdout[0] === 0xfe && stdout[1] === 0xff) {
    throw new TypeError('Big-endian WSL output is not supported.');
  }
  if (stdout[0] === 0xef && stdout[1] === 0xbb && stdout[2] === 0xbf) {
    return new TextDecoder('utf-8', { fatal: true }).decode(stdout.subarray(3));
  }
  if (stdout.includes(0)) {
    if (stdout.byteLength % 2 !== 0) {
      throw new TypeError('UTF-16LE WSL output has an invalid byte length.');
    }
    return new TextDecoder('utf-16le', { fatal: true }).decode(stdout);
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(stdout);
  } catch (utf8Error) {
    if (stdout.byteLength % 2 !== 0) throw utf8Error;
    return new TextDecoder('utf-16le', { fatal: true }).decode(stdout);
  }
}

export function createWslDistributionId(revision: number, name: string): string {
  const normalizedName = normalizeWslDistributionName(name);
  const digest = createHash('sha256')
    .update('daily-workbench-wsl-distribution-v1\0')
    .update(String(revision))
    .update('\0')
    .update(normalizedName)
    .digest('hex');
  return `wsl-${digest}`;
}

function frozenSnapshot(
  status: TerminalWslCapabilityStatus,
  capabilityRevision: number,
  executable?: string,
  distributions: readonly DiscoveredWslDistribution[] = [],
): WslDiscoverySnapshot {
  return Object.freeze({
    status,
    capabilityRevision,
    ...(executable ? { executable } : {}),
    distributions: Object.freeze([...distributions]),
  });
}

function runWslList(executable: string, signal: AbortSignal): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    execFile(
      executable,
      ['--list', '--quiet'],
      {
        encoding: 'buffer',
        maxBuffer: WSL_PROBE_MAX_BYTES,
        timeout: WSL_PROBE_TIMEOUT_MS,
        windowsHide: true,
        signal,
      },
      (error, stdout) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(stdout);
      },
    );
  });
}
