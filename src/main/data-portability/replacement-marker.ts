export const REPLACEMENT_PHASES = [
  'ready',
  'old-moved',
  'new-installed',
  'validated',
  'committed',
  'rolling-back',
  'rolled-back',
] as const;

export type ReplacementPhase = (typeof REPLACEMENT_PHASES)[number];

export interface DatabaseReplacementMarker {
  readonly version: 1;
  readonly replacementId: string;
  readonly phase: ReplacementPhase;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly databaseFileName: string;
  readonly stagingFileName: string;
  readonly rollbackFileName: string;
  readonly stagingSha256: string;
  readonly preImportBackupId: string;
}

export interface ReplacementMarkerPersistence {
  read(): Promise<unknown | undefined>;
  write(marker: DatabaseReplacementMarker): Promise<void>;
  remove(): Promise<void>;
}

export interface CreateReplacementMarkerInput {
  readonly replacementId: string;
  readonly timestamp: string;
  readonly databaseFileName: string;
  readonly stagingFileName: string;
  readonly rollbackFileName: string;
  readonly stagingSha256: string;
  readonly preImportBackupId: string;
}

export type ReplacementRecoveryAction =
  | 'move-old-database'
  | 'install-staged-database'
  | 'validate-installed-database'
  | 'commit-replacement'
  | 'restore-old-database'
  | 'cleanup';

const ALLOWED_TRANSITIONS: Readonly<Record<ReplacementPhase, readonly ReplacementPhase[]>> = {
  ready: ['old-moved', 'rolled-back'],
  'old-moved': ['new-installed', 'rolling-back'],
  'new-installed': ['validated', 'rolling-back'],
  validated: ['committed', 'rolling-back'],
  committed: ['rolling-back'],
  'rolling-back': ['rolled-back'],
  'rolled-back': [],
};

export class ReplacementMarkerStore {
  readonly #persistence: ReplacementMarkerPersistence;

  constructor(persistence: ReplacementMarkerPersistence) {
    this.#persistence = persistence;
  }

  async create(input: CreateReplacementMarkerInput): Promise<DatabaseReplacementMarker> {
    if (await this.read()) throw new Error('A database replacement is already pending.');
    const marker: DatabaseReplacementMarker = {
      version: 1,
      replacementId: input.replacementId.toLowerCase(),
      phase: 'ready',
      createdAt: input.timestamp,
      updatedAt: input.timestamp,
      databaseFileName: input.databaseFileName,
      stagingFileName: input.stagingFileName,
      rollbackFileName: input.rollbackFileName,
      stagingSha256: input.stagingSha256,
      preImportBackupId: input.preImportBackupId.toLowerCase(),
    };
    validateReplacementMarker(marker);
    await this.#persistence.write(marker);
    return marker;
  }

  async read(): Promise<DatabaseReplacementMarker | undefined> {
    const value = await this.#persistence.read();
    return value === undefined ? undefined : parseReplacementMarker(value);
  }

  async transition(
    expectedPhase: ReplacementPhase,
    nextPhase: ReplacementPhase,
    timestamp: string,
  ): Promise<DatabaseReplacementMarker> {
    const current = await this.read();
    if (!current || current.phase !== expectedPhase) {
      throw new Error('The database replacement phase changed unexpectedly.');
    }
    if (!ALLOWED_TRANSITIONS[expectedPhase].includes(nextPhase)) {
      throw new Error(`Database replacement cannot move from ${expectedPhase} to ${nextPhase}.`);
    }
    validateIsoTimestamp(timestamp, 'replacement update time');
    const next: DatabaseReplacementMarker = {
      ...current,
      phase: nextPhase,
      updatedAt: timestamp < current.updatedAt ? current.updatedAt : timestamp,
    };
    await this.#persistence.write(next);
    return next;
  }

  async removeTerminal(): Promise<void> {
    const marker = await this.read();
    if (marker && marker.phase !== 'committed' && marker.phase !== 'rolled-back') {
      throw new Error('A non-terminal database replacement marker cannot be removed.');
    }
    await this.#persistence.remove();
  }
}

export function recoveryActionFor(marker: DatabaseReplacementMarker): ReplacementRecoveryAction {
  validateReplacementMarker(marker);
  switch (marker.phase) {
    case 'ready':
      return 'move-old-database';
    case 'old-moved':
      return 'install-staged-database';
    case 'new-installed':
      return 'validate-installed-database';
    case 'validated':
      return 'commit-replacement';
    case 'rolling-back':
      return 'restore-old-database';
    case 'committed':
    case 'rolled-back':
      return 'cleanup';
  }
}

export function parseReplacementMarker(value: unknown): DatabaseReplacementMarker {
  if (!isPlainObject(value)) throw new Error('The database replacement marker is invalid.');
  const expectedKeys = [
    'createdAt',
    'databaseFileName',
    'phase',
    'preImportBackupId',
    'replacementId',
    'rollbackFileName',
    'stagingFileName',
    'stagingSha256',
    'updatedAt',
    'version',
  ].sort();
  const actualKeys = Object.keys(value).sort();
  if (
    actualKeys.length !== expectedKeys.length ||
    actualKeys.some((key, index) => key !== expectedKeys[index])
  ) {
    throw new Error('The database replacement marker fields are invalid.');
  }
  const marker = value as unknown as DatabaseReplacementMarker;
  validateReplacementMarker(marker);
  return { ...marker };
}

export function validateReplacementMarker(marker: DatabaseReplacementMarker): void {
  if (
    marker.version !== 1 ||
    !REPLACEMENT_PHASES.includes(marker.phase) ||
    !isUuid(marker.replacementId) ||
    !isUuid(marker.preImportBackupId) ||
    !isSafeFileName(marker.databaseFileName, /\.sqlite3?$/u) ||
    !isSafeFileName(marker.stagingFileName, /^import-[0-9a-f-]{36}\.sqlite3$/u) ||
    marker.stagingFileName !== `import-${marker.replacementId}.sqlite3` ||
    !isSafeFileName(marker.rollbackFileName, /^rollback-[0-9a-f-]{36}\.sqlite3$/u) ||
    marker.rollbackFileName !== `rollback-${marker.replacementId}.sqlite3` ||
    !/^[0-9a-f]{64}$/u.test(marker.stagingSha256)
  ) {
    throw new Error('The database replacement marker values are invalid.');
  }
  validateIsoTimestamp(marker.createdAt, 'replacement creation time');
  validateIsoTimestamp(marker.updatedAt, 'replacement update time');
  if (marker.updatedAt < marker.createdAt) {
    throw new Error('The database replacement marker time moved backwards.');
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isUuid(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value)
  );
}

function isSafeFileName(value: unknown, pattern: RegExp): value is string {
  return (
    typeof value === 'string' &&
    value.length <= 128 &&
    !value.includes('/') &&
    !value.includes('\\') &&
    value !== '.' &&
    value !== '..' &&
    pattern.test(value)
  );
}

function validateIsoTimestamp(value: unknown, name: string): asserts value is string {
  if (typeof value !== 'string') throw new Error(`The ${name} is invalid.`);
  const date = new Date(value);
  if (!Number.isFinite(date.getTime()) || date.toISOString() !== value) {
    throw new Error(`The ${name} is invalid.`);
  }
}
