import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  AUTOMATION_DATA_PACKAGE_FORMAT_VERSION,
  DATA_PACKAGE_FORMAT_VERSION,
  DEFAULT_MAX_PACKAGE_BYTES,
  DEFAULT_MAX_RECORD_BYTES,
  DEFAULT_MAX_RECORDS,
  LEGACY_DATA_PACKAGE_FORMAT_VERSION,
  DataPackageError,
  canonicalJson,
  parsePortablePackage,
  serializePortablePackage,
  type PortableDataRecord,
} from '../src/main/data-portability/package-format';

const WORKSPACE_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const AUTOMATION_ID = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const FOCUS_SESSION_ID = '12121212-1212-4121-8121-121212121212';

const records: readonly PortableDataRecord[] = [
  {
    type: 'app-state',
    data: { currentWorkspaceId: WORKSPACE_ID },
  },
  {
    type: 'workspace',
    data: {
      id: WORKSPACE_ID,
      name: '主工作区',
      archivedAt: null,
    },
  },
  {
    type: 'workspace-preference',
    data: { workspaceId: WORKSPACE_ID, theme: 'dark' },
  },
  {
    type: 'note',
    data: {
      id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      workspaceId: WORKSPACE_ID,
      title: 'Unicode ✅',
      body: '第一行\n第二行',
    },
  },
  {
    type: 'browser-bookmark',
    data: {
      id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      workspaceId: WORKSPACE_ID,
      url: 'https://example.com/',
      title: 'Example',
    },
  },
];

const automationRecord: PortableDataRecord = {
  type: 'automation-definition',
  data: {
    id: AUTOMATION_ID,
    workspaceId: WORKSPACE_ID,
    name: '每天准备工作台',
    enabled: true,
    schedule: {
      cadence: 'daily',
      localTimeMinute: 8 * 60 + 30,
      weekday: null,
    },
    action: {
      kind: 'create-today-task',
      title: '整理今日计划',
    },
    revision: 3,
    createdAt: '2026-07-22T11:00:00.000Z',
    updatedAt: '2026-07-22T12:00:00.000Z',
    archivedAt: null,
  },
};

const focusSessionRecord: PortableDataRecord = {
  type: 'focus-session',
  data: {
    id: FOCUS_SESSION_ID,
    workspaceId: WORKSPACE_ID,
    taskId: null,
    status: 'paused',
    remainingSeconds: 900,
    revision: 2,
    localDate: '2026-07-22',
    createdAt: '2026-07-22T11:00:00.000Z',
    updatedAt: '2026-07-22T11:10:00.000Z',
    completedAt: null,
  },
};

describe('portable data package', () => {
  it('round-trips canonical NDJSON with verified counts and digest', () => {
    const bytes = serializePortablePackage({
      exportId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
      exportedAt: '2026-07-22T12:00:00.000Z',
      sourceAppVersion: '0.1.0',
      sourceSchemaVersion: 7,
      records,
    });
    const parsed = parsePortablePackage(bytes);
    expect(parsed.manifest.formatVersion).toBe(LEGACY_DATA_PACKAGE_FORMAT_VERSION);
    expect(parsed.currentWorkspaceName).toBe('主工作区');
    expect(parsed.manifest.recordCount).toBe(records.length);
    expect(parsed.manifest.counts).toMatchObject({
      workspaces: 1,
      notes: 1,
      browserBookmarks: 1,
      automations: 0,
      enabledAutomations: 0,
      focusSessions: 0,
    });
    expect(parsed.packageSha256).toMatch(/^[0-9a-f]{64}$/u);
  });

  it('emits v2 for schema 9, counts automation definitions, and keeps v1 exact', () => {
    const v2 = serializePortablePackage({
      exportId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
      exportedAt: '2026-07-22T12:00:00.000Z',
      sourceAppVersion: '0.1.0',
      sourceSchemaVersion: 9,
      records: [...records, automationRecord],
    });
    const parsedV2 = parsePortablePackage(v2);
    expect(parsedV2.manifest).toMatchObject({
      formatVersion: AUTOMATION_DATA_PACKAGE_FORMAT_VERSION,
      sourceSchemaVersion: 9,
      counts: {
        automations: 1,
        enabledAutomations: 1,
      },
    });
    expect(parsedV2.records.at(-1)).toEqual(automationRecord);
    const rawV2Manifest = JSON.parse(v2.toString('utf8').split('\n', 1)[0]) as Record<
      string,
      unknown
    >;
    expect(rawV2Manifest.counts).not.toHaveProperty('focusSessions');
    expect(parsedV2.manifest.counts.focusSessions).toBe(0);

    const v1 = serializePortablePackage({
      exportId: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
      exportedAt: '2026-07-22T12:00:00.000Z',
      sourceAppVersion: '0.1.0',
      sourceSchemaVersion: 8,
      records,
    });
    const rawManifest = JSON.parse(v1.toString('utf8').split('\n', 1)[0]) as Record<
      string,
      unknown
    >;
    expect(rawManifest.formatVersion).toBe(LEGACY_DATA_PACKAGE_FORMAT_VERSION);
    expect(rawManifest.counts).not.toHaveProperty('automations');
    expect(rawManifest.counts).not.toHaveProperty('enabledAutomations');
    expect(parsePortablePackage(v1).manifest.counts).toMatchObject({
      automations: 0,
      enabledAutomations: 0,
      focusSessions: 0,
    });
  });

  it.each([10, 11] as const)(
    'emits v3 focus sessions for source schema %i with exact counts and graph validation',
    (sourceSchemaVersion) => {
      const bytes = serializePortablePackage({
        exportId: '13131313-1313-4131-8131-131313131313',
        exportedAt: '2026-07-22T12:00:00.000Z',
        sourceAppVersion: '0.1.0',
        sourceSchemaVersion,
        records: [...records, automationRecord, focusSessionRecord],
      });
      const parsed = parsePortablePackage(bytes);

      expect(parsed.manifest).toMatchObject({
        formatVersion: DATA_PACKAGE_FORMAT_VERSION,
        sourceSchemaVersion,
        counts: {
          automations: 1,
          enabledAutomations: 1,
          focusSessions: 1,
        },
      });
      expect(parsed.records.at(-1)).toEqual(focusSessionRecord);
    },
  );

  it('binds formats to schemas and rejects automation runtime or extra action fields', () => {
    expect(() =>
      serializePortablePackage({
        exportId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
        exportedAt: '2026-07-22T12:00:00.000Z',
        sourceAppVersion: '0.1.0',
        sourceSchemaVersion: 8,
        records: [...records, automationRecord],
      }),
    ).toThrow(DataPackageError);
    expect(() =>
      serializePortablePackage({
        exportId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
        exportedAt: '2026-07-22T12:00:00.000Z',
        sourceAppVersion: '0.1.0',
        sourceSchemaVersion: 9,
        records: [
          ...records,
          {
            ...automationRecord,
            data: { ...automationRecord.data, lastRun: { status: 'never' } },
          },
        ],
      }),
    ).toThrow(DataPackageError);
    expect(() =>
      serializePortablePackage({
        exportId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
        exportedAt: '2026-07-22T12:00:00.000Z',
        sourceAppVersion: '0.1.0',
        sourceSchemaVersion: 9,
        records: [
          ...records,
          {
            ...automationRecord,
            data: {
              ...automationRecord.data,
              effectiveAt: '2026-07-23T08:30:00.000Z',
            },
          },
        ],
      }),
    ).toThrow(DataPackageError);
    expect(() =>
      serializePortablePackage({
        exportId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
        exportedAt: '2026-07-22T12:00:00.000Z',
        sourceAppVersion: '0.1.0',
        sourceSchemaVersion: 9,
        records: [
          ...records,
          {
            ...automationRecord,
            data: {
              ...automationRecord.data,
              action: {
                kind: 'create-today-task',
                title: '整理今日计划',
                command: 'whoami',
              },
            },
          },
        ],
      }),
    ).toThrow(DataPackageError);

    const validV2 = serializePortablePackage({
      exportId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
      exportedAt: '2026-07-22T12:00:00.000Z',
      sourceAppVersion: '0.1.0',
      sourceSchemaVersion: 9,
      records: [...records, automationRecord],
    });
    expect(() =>
      parsePortablePackage(
        mutateManifest(validV2, (manifest) => ({ ...manifest, formatVersion: 1 })),
      ),
    ).toThrow(DataPackageError);
    expect(() =>
      parsePortablePackage(
        mutateManifest(validV2, (manifest) => {
          const counts = { ...(manifest.counts as Record<string, unknown>) };
          delete counts.automations;
          return { ...manifest, counts };
        }),
      ),
    ).toThrow(DataPackageError);
  });

  it('rejects focus sessions in old formats and invalid portable focus state', () => {
    for (const sourceSchemaVersion of [8, 9]) {
      expect(() =>
        serializePortablePackage({
          exportId: '14141414-1414-4141-8141-141414141414',
          exportedAt: '2026-07-22T12:00:00.000Z',
          sourceAppVersion: '0.1.0',
          sourceSchemaVersion,
          records: [...records, focusSessionRecord],
        }),
      ).toThrow(DataPackageError);
    }

    const invalidRecords: readonly PortableDataRecord[] = [
      {
        ...focusSessionRecord,
        data: { ...focusSessionRecord.data, status: 'running' },
      },
      {
        ...focusSessionRecord,
        data: { ...focusSessionRecord.data, status: 'cancelled' },
      },
      {
        ...focusSessionRecord,
        data: { ...focusSessionRecord.data, remainingSeconds: 1_501 },
      },
      {
        ...focusSessionRecord,
        data: { ...focusSessionRecord.data, remainingSeconds: 0 },
      },
      {
        ...focusSessionRecord,
        data: {
          ...focusSessionRecord.data,
          status: 'completed',
          remainingSeconds: 1,
          completedAt: '2026-07-22T11:10:00.000Z',
        },
      },
      {
        ...focusSessionRecord,
        data: { ...focusSessionRecord.data, deadlineAt: '2026-07-22T11:25:00.000Z' },
      },
      {
        ...focusSessionRecord,
        data: {
          ...focusSessionRecord.data,
          taskId: '15151515-1515-4151-8151-151515151515',
        },
      },
    ];
    for (const record of invalidRecords) {
      expect(() =>
        serializePortablePackage({
          exportId: '16161616-1616-4161-8161-161616161616',
          exportedAt: '2026-07-22T12:00:00.000Z',
          sourceAppVersion: '0.1.0',
          sourceSchemaVersion: 10,
          records: [...records, record],
        }),
      ).toThrow(DataPackageError);
    }

    expect(() =>
      serializePortablePackage({
        exportId: '17171717-1717-4171-8171-171717171717',
        exportedAt: '2026-07-22T12:00:00.000Z',
        sourceAppVersion: '0.1.0',
        sourceSchemaVersion: 10,
        records: [
          ...records,
          focusSessionRecord,
          {
            ...focusSessionRecord,
            data: {
              ...focusSessionRecord.data,
              id: '18181818-1818-4181-8181-181818181818',
            },
          },
        ],
      }),
    ).toThrow(DataPackageError);
  });

  it('rejects tampering, non-canonical JSON, unknown fields, and tight limits', () => {
    const bytes = serializePortablePackage({
      exportId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
      exportedAt: '2026-07-22T12:00:00.000Z',
      sourceAppVersion: '0.1.0',
      sourceSchemaVersion: 7,
      records,
    });
    const tampered = Buffer.from(bytes);
    const offset = tampered.indexOf(Buffer.from('Unicode'));
    tampered[offset] = 'X'.charCodeAt(0);
    expect(() => parsePortablePackage(tampered)).toThrow(DataPackageError);

    const text = bytes.toString('utf8');
    const nonCanonical = Buffer.from(` ${text}`, 'utf8');
    expect(() => parsePortablePackage(nonCanonical)).toThrow(DataPackageError);
    expect(() => parsePortablePackage(bytes, { maxRecords: 2 })).toThrow(DataPackageError);
    expect(() => parsePortablePackage(bytes, { maxPackageBytes: 10 })).toThrow(DataPackageError);
    expect(() =>
      parsePortablePackage(bytes, { maxPackageBytes: DEFAULT_MAX_PACKAGE_BYTES + 1 }),
    ).toThrow(TypeError);
    expect(() =>
      parsePortablePackage(bytes, { maxRecordBytes: DEFAULT_MAX_RECORD_BYTES + 1 }),
    ).toThrow(TypeError);
    expect(() => parsePortablePackage(bytes, { maxRecords: DEFAULT_MAX_RECORDS + 1 })).toThrow(
      TypeError,
    );
  });

  it('requires exactly one state pointing at an exported workspace', () => {
    expect(() =>
      serializePortablePackage({
        exportId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
        exportedAt: '2026-07-22T12:00:00.000Z',
        sourceAppVersion: '0.1.0',
        sourceSchemaVersion: 7,
        records: records.slice(1),
      }),
    ).toThrow(DataPackageError);
  });

  it('rejects nested and near-record-limit arrays without copying their elements', () => {
    const nested =
      '{"data":{"currentWorkspaceId":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","payload":{"nested":[0]}},"type":"app-state"}';
    expect(() => parsePortablePackage(createRawPackage(nested))).toThrow(/arrays/u);

    const tinyElements = `[${'0,'.repeat(499_999)}0]`;
    const large =
      `{"data":{"currentWorkspaceId":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",` +
      `"payload":${tinyElements}},"type":"app-state"}`;
    expect(Buffer.byteLength(large, 'utf8')).toBeLessThan(1024 * 1024);
    expect(() => parsePortablePackage(createRawPackage(large))).toThrow(/arrays/u);
  });
});

function createRawPackage(recordLine: string): Buffer {
  const body = `${recordLine}\n`;
  const manifest = {
    bodySha256: createHash('sha256').update(body, 'utf8').digest('hex'),
    counts: {
      archivedWorkspaces: 0,
      browserBookmarks: 0,
      browserTabs: 0,
      inboxEntries: 0,
      notes: 0,
      scheduleItems: 0,
      tasks: 0,
      workspaces: 0,
    },
    exportId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
    exportedAt: '2026-07-22T12:00:00.000Z',
    format: 'daily-workbench-portable',
    formatVersion: 1,
    recordCount: 1,
    sourceAppVersion: '0.1.0',
    sourceSchemaVersion: 7,
  };
  return Buffer.from(`${JSON.stringify(manifest)}\n${body}`, 'utf8');
}

function mutateManifest(
  bytes: Buffer,
  mutate: (manifest: Record<string, unknown>) => Record<string, unknown>,
): Buffer {
  const text = bytes.toString('utf8');
  const newline = text.indexOf('\n');
  const manifest = JSON.parse(text.slice(0, newline)) as Record<string, unknown>;
  return Buffer.from(`${canonicalJson(mutate(manifest))}${text.slice(newline)}`, 'utf8');
}
