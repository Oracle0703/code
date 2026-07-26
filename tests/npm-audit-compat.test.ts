import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

import { describe, expect, it, vi } from 'vitest';

interface AuditResponse {
  readonly url: string;
  readonly status: number;
  readonly headers: {
    get(name: string): string | null;
  };
  readonly body: Readable;
  readonly bodyUsed: boolean;
  readonly timeout: number;
  clone(): AuditResponse;
  json(): Promise<unknown>;
}

interface AuditFetchOptions {
  readonly method?: string;
  readonly registry?: string;
  readonly gzip?: boolean;
  readonly body?: unknown;
  readonly query?: unknown;
}

type RegistryFetch = (uri: string, options?: AuditFetchOptions) => Promise<AuditResponse>;

interface CompatibilityModule {
  readonly AUDIT_PATH: string;
  readonly AUDIT_REGISTRY: string;
  readonly AUDIT_URL: string;
  createCompatibleRegistryFetch(
    originalFetch: RegistryFetch,
    options?: {
      readonly onCompatibility?: (event: {
        readonly wireBytes: number;
        readonly decodedBytes: number;
      }) => void;
    },
  ): RegistryFetch;
  isExactAuditRequest(uri: unknown, options?: unknown): boolean;
  isExactAuditResponse(response: unknown): boolean;
  parseAuditJsonBody(
    wire: Buffer,
    options?: {
      readonly maxWireBytes?: number;
      readonly maxDecompressedBytes?: number;
    },
  ): {
    readonly value: Readonly<Record<string, unknown>>;
    readonly wasGzip: boolean;
    readonly decodedBytes: number;
  };
  readBodyWithLimit(body: Readable, maxBytes: number, timeoutMs: number): Promise<Buffer>;
}

const localRequire = createRequire(import.meta.url);
const compatibility = localRequire('../scripts/npm-audit-compat.cjs') as CompatibilityModule;
const preloadPath = fileURLToPath(new URL('../scripts/npm-audit-preload.cjs', import.meta.url));
const runnerPath = fileURLToPath(new URL('../scripts/run-npm-audit.mjs', import.meta.url));
const preloadEnvironmentName = 'DAILY_WORKBENCH_NPM_AUDIT_CLI';
const requestedPackages = Object.freeze({
  alpha: ['1.0.0'],
  '@scope/beta': ['2.0.0'],
});
const advisoryResponse = Object.freeze({
  alpha: [{ id: 123, title: 'Test advisory' }],
});
const exactRequest = Object.freeze({
  method: 'POST',
  registry: compatibility.AUDIT_REGISTRY,
  gzip: true,
  body: requestedPackages,
});

describe('npm audit response compatibility', () => {
  it('matches only the pinned official bulk POST with a gzip request body', () => {
    expect(compatibility.isExactAuditRequest(compatibility.AUDIT_PATH, exactRequest)).toBe(true);

    for (const [uri, options] of [
      ['/other', exactRequest],
      [`${compatibility.AUDIT_PATH}?retry=1`, exactRequest],
      [compatibility.AUDIT_PATH, { ...exactRequest, method: 'GET' }],
      [compatibility.AUDIT_PATH, { ...exactRequest, gzip: false }],
      [compatibility.AUDIT_PATH, { ...exactRequest, query: { retry: 1 } }],
      [compatibility.AUDIT_PATH, { ...exactRequest, registry: 'http://registry.npmjs.org/' }],
      [
        compatibility.AUDIT_PATH,
        { ...exactRequest, registry: 'https://registry.npmjs.org.evil.example/' },
      ],
      [compatibility.AUDIT_PATH, { ...exactRequest, registry: 'https://registry.npmjs.org/path/' }],
      [compatibility.AUDIT_PATH, { ...exactRequest, registry: 'https://user@registry.npmjs.org/' }],
    ] as const) {
      expect(compatibility.isExactAuditRequest(uri, options)).toBe(false);
    }
  });

  it('requires the final response to remain on the exact official URL with status 200', () => {
    expect(
      compatibility.isExactAuditResponse({
        status: 200,
        url: compatibility.AUDIT_URL,
      }),
    ).toBe(true);
    expect(
      compatibility.isExactAuditResponse({
        status: 200,
        url: `${compatibility.AUDIT_URL}?redirected=1`,
      }),
    ).toBe(false);
    expect(
      compatibility.isExactAuditResponse({
        status: 200,
        url: 'https://registry.npmjs.org.evil.example/-/npm/v1/security/advisories/bulk',
      }),
    ).toBe(false);
    expect(
      compatibility.isExactAuditResponse({
        status: 204,
        url: compatibility.AUDIT_URL,
      }),
    ).toBe(false);
  });

  it('decodes the reproduced headerless gzip response across one-byte chunks', async () => {
    const wire = gzipSync(Buffer.from(JSON.stringify(advisoryResponse)));
    const response = fakeResponse(wire, {
      chunks: [...wire].map((byte) => Buffer.from([byte])),
    });
    const originalFetch = vi.fn(async () => response);
    const onCompatibility = vi.fn();
    const wrappedFetch = compatibility.createCompatibleRegistryFetch(originalFetch, {
      onCompatibility,
    });

    const result = await wrappedFetch(compatibility.AUDIT_PATH, exactRequest);
    await expect(result.json()).resolves.toEqual(advisoryResponse);
    expect(response.originalJson).not.toHaveBeenCalled();
    expect(onCompatibility).toHaveBeenCalledExactlyOnceWith({
      wireBytes: wire.length,
      decodedBytes: Buffer.byteLength(JSON.stringify(advisoryResponse)),
    });
  });

  it('accepts ordinary UTF-8 JSON when the exact response has no encoding header', async () => {
    const wire = Buffer.from(JSON.stringify(advisoryResponse));
    const response = fakeResponse(wire, {
      originalJsonValue: advisoryResponse,
    });
    const wrappedFetch = compatibility.createCompatibleRegistryFetch(vi.fn(async () => response));

    const result = await wrappedFetch(compatibility.AUDIT_PATH, exactRequest);
    await expect(result.json()).resolves.toEqual(advisoryResponse);
    expect(response.originalJson).toHaveBeenCalledOnce();
  });

  it('drains the real minipass-fetch clone while preserving native JSON parsing', async () => {
    const npmCli = process.env.npm_execpath;
    expect(npmCli).toBeTruthy();
    const npmRequire = createRequire(npmCli!);
    const { Response } = npmRequire('minipass-fetch') as {
      readonly Response: new (
        body: Readable,
        options: {
          readonly status: number;
          readonly timeout: number;
          readonly url: string;
        },
      ) => AuditResponse;
    };
    const { Minipass } = npmRequire('minipass') as {
      readonly Minipass: new () => Readable & {
        write(chunk: Buffer): boolean;
        end(): void;
      };
    };

    const largeResponse = {
      alpha: [{ id: 123, title: 'x'.repeat(192 * 1_024) }],
    };
    const wire = Buffer.from(JSON.stringify(largeResponse));
    const source = new Minipass();
    const response = new Response(source, {
      status: 200,
      timeout: 1_000,
      url: compatibility.AUDIT_URL,
    });
    const wrappedFetch = compatibility.createCompatibleRegistryFetch(vi.fn(async () => response));

    let offset = 0;
    const writeNext = () => {
      while (offset < wire.length) {
        const chunk = wire.subarray(offset, offset + 1_024);
        offset += chunk.length;
        if (!source.write(chunk)) {
          source.once('drain', writeNext);
          return;
        }
      }
      source.end();
    };
    setImmediate(writeNext);

    const result = await withTimeout(wrappedFetch(compatibility.AUDIT_PATH, exactRequest), 3_000);
    await expect(withTimeout(result.json(), 3_000)).resolves.toEqual(largeResponse);
  });

  it('fully delegates when Content-Encoding is present', async () => {
    const delegated = Object.freeze({ delegated: true });
    const response = fakeResponse(gzipSync(Buffer.from('{}')), {
      contentEncoding: 'gzip',
      originalJsonValue: delegated,
    });
    const wrappedFetch = compatibility.createCompatibleRegistryFetch(vi.fn(async () => response));

    const result = await wrappedFetch(compatibility.AUDIT_PATH, exactRequest);
    await expect(result.json()).resolves.toBe(delegated);
    expect(response.originalJson).toHaveBeenCalledOnce();
    expect(response.body.readableEnded).toBe(false);
  });

  it('does not consume responses for non-target requests or redirected final URLs', async () => {
    const response = fakeResponse(Buffer.from('not-json'), {
      originalJsonValue: 'delegated',
    });
    const originalFetch = vi.fn(async () => response);
    const wrappedFetch = compatibility.createCompatibleRegistryFetch(originalFetch);

    const nonTarget = await wrappedFetch('/other', exactRequest);
    await expect(nonTarget.json()).resolves.toBe('delegated');
    expect(response.originalJson).toHaveBeenCalledOnce();

    const redirected = fakeResponse(Buffer.from('not-json'), {
      url: 'https://registry.npmjs.org.evil.example/-/npm/v1/security/advisories/bulk',
      originalJsonValue: 'redirected',
    });
    const redirectedFetch = compatibility.createCompatibleRegistryFetch(
      vi.fn(async () => redirected),
    );
    const redirectedResult = await redirectedFetch(compatibility.AUDIT_PATH, exactRequest);
    await expect(redirectedResult.json()).resolves.toBe('redirected');
    expect(redirected.originalJson).toHaveBeenCalledOnce();
  });

  it('preserves npm-registry-fetch business properties', () => {
    const originalFetch = Object.assign(
      vi.fn(async () => fakeResponse(Buffer.from('{}'))),
      {
        getAuth: vi.fn(),
        json: vi.fn(),
        pickRegistry: vi.fn(),
      },
    ) as unknown as RegistryFetch & {
      readonly getAuth: unknown;
      readonly json: unknown;
      readonly pickRegistry: unknown;
    };
    const wrappedFetch = compatibility.createCompatibleRegistryFetch(
      originalFetch,
    ) as RegistryFetch & {
      readonly getAuth: unknown;
      readonly json: unknown;
      readonly pickRegistry: unknown;
    };

    expect(wrappedFetch.getAuth).toBe(originalFetch.getAuth);
    expect(wrappedFetch.json).toBe(originalFetch.json);
    expect(wrappedFetch.pickRegistry).toBe(originalFetch.pickRegistry);
  });

  it('fails closed on a headerless gzip response when the exact request body is invalid', async () => {
    const originalFetch = vi.fn(async () => fakeResponse(gzipSync(Buffer.from('{}'))));
    const wrappedFetch = compatibility.createCompatibleRegistryFetch(originalFetch);

    await expect(
      wrappedFetch(compatibility.AUDIT_PATH, {
        ...exactRequest,
        body: { alpha: [] },
      }),
    ).rejects.toMatchObject({
      code: 'EAUDITRESPONSECOMPAT',
    });
    expect(originalFetch).toHaveBeenCalledOnce();
  });

  it('fails closed on a declared Content-Length mismatch and repeated consumption', async () => {
    const wire = gzipSync(Buffer.from(JSON.stringify(advisoryResponse)));
    const mismatched = fakeResponse(wire, {
      contentLength: String(wire.length + 1),
    });
    const mismatchedFetch = compatibility.createCompatibleRegistryFetch(
      vi.fn(async () => mismatched),
    );
    const mismatchedResult = await mismatchedFetch(compatibility.AUDIT_PATH, exactRequest);
    await expect(mismatchedResult.json()).rejects.toMatchObject({
      code: 'EAUDITRESPONSECOMPAT',
    });

    const response = fakeResponse(wire);
    const wrappedFetch = compatibility.createCompatibleRegistryFetch(vi.fn(async () => response));
    const result = await wrappedFetch(compatibility.AUDIT_PATH, exactRequest);
    await expect(result.json()).resolves.toEqual(advisoryResponse);
    await expect(result.json()).rejects.toThrow('body used already');
  });

  it('rejects response packages that were not in the exact bulk request', async () => {
    const response = fakeResponse(
      gzipSync(
        Buffer.from(
          JSON.stringify({
            unexpected: [{ id: 123 }],
          }),
        ),
      ),
    );
    const wrappedFetch = compatibility.createCompatibleRegistryFetch(vi.fn(async () => response));
    const result = await wrappedFetch(compatibility.AUDIT_PATH, exactRequest);

    await expect(result.json()).rejects.toMatchObject({
      code: 'EAUDITRESPONSECOMPAT',
    });
  });

  it('enforces wire and decoded limits before returning parsed JSON', () => {
    const plain = Buffer.from(JSON.stringify(advisoryResponse));
    expect(() =>
      compatibility.parseAuditJsonBody(plain, {
        maxWireBytes: plain.length - 1,
      }),
    ).toThrowError(expect.objectContaining({ code: 'EAUDITRESPONSECOMPAT' }));

    const expanded = Buffer.from(
      JSON.stringify({
        alpha: [{ text: 'x'.repeat(1_024) }],
      }),
    );
    const compressed = gzipSync(expanded);
    expect(() =>
      compatibility.parseAuditJsonBody(compressed, {
        maxWireBytes: compressed.length,
        maxDecompressedBytes: expanded.length - 1,
      }),
    ).toThrowError(expect.objectContaining({ code: 'EAUDITRESPONSECOMPAT' }));
  });

  it.each([
    ['truncated member', (wire: Buffer) => wire.subarray(0, wire.length - 1)],
    [
      'bad CRC32',
      (wire: Buffer) => {
        const copy = Buffer.from(wire);
        copy[copy.length - 8] ^= 0xff;
        return copy;
      },
    ],
    [
      'bad ISIZE',
      (wire: Buffer) => {
        const copy = Buffer.from(wire);
        copy[copy.length - 4] ^= 0xff;
        return copy;
      },
    ],
    [
      'reserved flags',
      (wire: Buffer) => {
        const copy = Buffer.from(wire);
        copy[3] |= 0xe0;
        return copy;
      },
    ],
    ['trailing zero', (wire: Buffer) => Buffer.concat([wire, Buffer.from([0])])],
    ['multiple members', (wire: Buffer) => Buffer.concat([wire, gzipSync(Buffer.from(' '))])],
  ])('rejects gzip integrity violation: %s', (_name, mutate) => {
    const wire = gzipSync(Buffer.from(JSON.stringify(advisoryResponse)));
    expect(() => compatibility.parseAuditJsonBody(mutate(wire))).toThrowError(
      expect.objectContaining({ code: 'EAUDITRESPONSECOMPAT' }),
    );
  });

  it('rejects invalid UTF-8, invalid JSON, and non-object JSON', () => {
    for (const wire of [
      Buffer.from([0xc3, 0x28]),
      Buffer.from('{}{}'),
      Buffer.from('[]'),
      Buffer.from('null'),
    ]) {
      expect(() => compatibility.parseAuditJsonBody(wire)).toThrowError(
        expect.objectContaining({ code: 'EAUDITRESPONSECOMPAT' }),
      );
    }
  });

  it('reads arbitrary binary chunks with a hard byte limit', async () => {
    await expect(
      compatibility.readBodyWithLimit(
        Readable.from([Buffer.from('ab'), Buffer.from('cd')]),
        4,
        1_000,
      ),
    ).resolves.toEqual(Buffer.from('abcd'));
    await expect(
      compatibility.readBodyWithLimit(
        Readable.from([Buffer.from('ab'), Buffer.from('cde')]),
        4,
        1_000,
      ),
    ).rejects.toMatchObject({
      code: 'EAUDITRESPONSECOMPAT',
    });
  });

  it('preload installation succeeds only with its dedicated absolute npm CLI', () => {
    const npmCli = process.env.npm_execpath;
    expect(npmCli).toBeTruthy();

    const valid = spawnSync(process.execPath, ['--require', preloadPath, npmCli!, '--version'], {
      encoding: 'utf8',
      env: {
        ...process.env,
        [preloadEnvironmentName]: npmCli,
      },
      shell: false,
    });
    expect(valid.status, valid.stderr).toBe(0);
    expect(valid.stdout.trim()).toBe('11.9.0');

    const missingEnvironment = { ...process.env };
    delete missingEnvironment[preloadEnvironmentName];
    const missing = spawnSync(process.execPath, ['--require', preloadPath, npmCli!, '--version'], {
      encoding: 'utf8',
      env: missingEnvironment,
      shell: false,
    });
    expect(missing.status).not.toBe(0);
    expect(missing.stderr).toContain(preloadEnvironmentName);

    const relative = spawnSync(process.execPath, ['--require', preloadPath, npmCli!, '--version'], {
      encoding: 'utf8',
      env: {
        ...process.env,
        [preloadEnvironmentName]: 'relative/npm-cli.js',
      },
      shell: false,
    });
    expect(relative.status).not.toBe(0);
    expect(relative.stderr).toContain('absolute npm CLI path');

    const npxCli = path.join(path.dirname(npmCli!), 'npx-cli.js');
    const siblingCli = spawnSync(
      process.execPath,
      ['--require', preloadPath, npxCli, '--version'],
      {
        encoding: 'utf8',
        env: {
          ...process.env,
          [preloadEnvironmentName]: npxCli,
        },
        shell: false,
      },
    );
    expect(siblingCli.status).not.toBe(0);
    expect(siblingCli.stderr).toContain('canonical bin/npm-cli.js');
  });

  it('runner rejects every profile outside the two fixed audit modes', () => {
    const result = spawnSync(process.execPath, [runnerPath, 'arbitrary'], {
      encoding: 'utf8',
      env: process.env,
      shell: false,
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('full or production');
  });
});

function fakeResponse(
  body: Buffer,
  {
    chunks = [body],
    contentEncoding = null,
    contentLength = null,
    originalJsonValue = Object.freeze({ original: true }),
    status = 200,
    url = compatibility.AUDIT_URL,
  }: {
    readonly chunks?: readonly Buffer[];
    readonly contentEncoding?: string | null;
    readonly contentLength?: string | null;
    readonly originalJsonValue?: unknown;
    readonly status?: number;
    readonly url?: string;
  } = {},
): AuditResponse & {
  readonly originalJson: ReturnType<typeof vi.fn>;
} {
  const originalJson = vi.fn(async () => originalJsonValue);
  const createResponse = (isClone: boolean): AuditResponse => ({
    url,
    status,
    headers: {
      get: (name) => {
        if (name.toLowerCase() === 'content-encoding') return contentEncoding;
        if (name.toLowerCase() === 'content-length') return contentLength;
        return null;
      },
    },
    body: Readable.from(chunks.map((chunk) => Buffer.from(chunk))),
    bodyUsed: false,
    timeout: 1_000,
    clone: () => createResponse(true),
    json: isClone ? vi.fn(async () => originalJsonValue) : originalJson,
  });
  return {
    ...createResponse(false),
    originalJson,
  };
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error(`Operation did not complete within ${timeoutMs}ms.`));
    }, timeoutMs);
    timeout.unref?.();

    promise.then(
      (value) => {
        clearTimeout(timeout);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timeout);
        reject(error);
      },
    );
  });
}
