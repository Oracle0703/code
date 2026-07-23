import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_MAX_PACKAGE_BYTES,
  DEFAULT_MAX_RECORD_BYTES,
  DEFAULT_MAX_RECORDS,
  DataPackageError,
  parsePortablePackage,
  serializePortablePackage,
  type PortableDataRecord,
} from '../src/main/data-portability/package-format';

const records: readonly PortableDataRecord[] = [
  {
    type: 'app-state',
    data: { currentWorkspaceId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' },
  },
  {
    type: 'workspace',
    data: {
      id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      name: '主工作区',
      archivedAt: null,
    },
  },
  {
    type: 'workspace-preference',
    data: { workspaceId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', theme: 'dark' },
  },
  {
    type: 'note',
    data: {
      id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      workspaceId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      title: 'Unicode ✅',
      body: '第一行\n第二行',
    },
  },
  {
    type: 'browser-bookmark',
    data: {
      id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      workspaceId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      url: 'https://example.com/',
      title: 'Example',
    },
  },
];

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
    expect(parsed.currentWorkspaceName).toBe('主工作区');
    expect(parsed.manifest.recordCount).toBe(records.length);
    expect(parsed.manifest.counts).toMatchObject({
      workspaces: 1,
      notes: 1,
      browserBookmarks: 1,
    });
    expect(parsed.packageSha256).toMatch(/^[0-9a-f]{64}$/u);
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
