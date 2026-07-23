import { describe, expect, it, vi } from 'vitest';
import { decodeWslDistributionNames, WslDiscovery } from '../src/main/terminal/wsl-discovery';

describe('WSL discovery', () => {
  it('decodes UTF-16LE and UTF-8 output without corrupting Unicode names', () => {
    const utf16 = Buffer.concat([
      Buffer.from([0xff, 0xfe]),
      Buffer.from('Ubuntu\r\n开发环境\r\n', 'utf16le'),
    ]);
    const utf8 = Buffer.concat([
      Buffer.from([0xef, 0xbb, 0xbf]),
      Buffer.from('Debian\nopenSUSE-Tumbleweed\n', 'utf8'),
    ]);

    expect(decodeWslDistributionNames(utf16)).toEqual(['Ubuntu', '开发环境']);
    expect(decodeWslDistributionNames(utf8)).toEqual(['Debian', 'openSUSE-Tumbleweed']);
  });

  it('rejects malformed, duplicate, control-bearing, excessive, and oversized output', () => {
    expect(() => decodeWslDistributionNames(Buffer.from('Ubuntu\nubuntu\n'))).toThrow('duplicate');
    expect(() => decodeWslDistributionNames(Buffer.from('Ubuntu\u0007\n'))).toThrow('invalid');
    expect(() =>
      decodeWslDistributionNames(
        Buffer.from(Array.from({ length: 65 }, (_, index) => `Distribution-${index}`).join('\n')),
      ),
    ).toThrow('too many');
    expect(() => decodeWslDistributionNames(Buffer.alloc(64 * 1024 + 1, 0x61))).toThrow(
      'too large',
    );
    expect(() => decodeWslDistributionNames(Buffer.from([0xfe, 0xff, 0x00, 0x41]))).toThrow(
      'Big-endian',
    );
  });

  it('distinguishes platform and probe outcomes and advances opaque capability revisions', async () => {
    const unsupportedRunner = vi.fn();
    const unsupported = new WslDiscovery({
      platform: 'linux',
      resolveExecutable: () => undefined,
      runList: unsupportedRunner,
    });
    await expect(unsupported.getSnapshot()).resolves.toMatchObject({
      status: 'unsupported',
      capabilityRevision: 1,
      distributions: [],
    });
    expect(unsupportedRunner).not.toHaveBeenCalled();

    const missing = new WslDiscovery({
      platform: 'win32',
      resolveExecutable: () => undefined,
    });
    await expect(missing.getSnapshot()).resolves.toMatchObject({
      status: 'not-installed',
      capabilityRevision: 1,
    });

    const outputs = [Buffer.from('Ubuntu\n'), Buffer.from('Ubuntu\nDebian\n'), Buffer.from('')];
    const ready = new WslDiscovery({
      platform: 'win32',
      resolveExecutable: () => 'C:\\Windows\\System32\\wsl.exe',
      runList: vi.fn(async () => outputs.shift() ?? Buffer.alloc(0)),
    });
    const first = await ready.getSnapshot();
    const second = await ready.refresh();
    const third = await ready.refresh();
    expect(first).toMatchObject({ status: 'ready', capabilityRevision: 1 });
    expect(second).toMatchObject({ status: 'ready', capabilityRevision: 2 });
    expect(third).toMatchObject({ status: 'no-distributions', capabilityRevision: 3 });
    expect(first.distributions[0]?.id).toMatch(/^wsl-[0-9a-f]{64}$/u);
    expect(second.distributions[0]?.id).not.toBe(first.distributions[0]?.id);
  });

  it('coalesces concurrent probes, reports probe errors, and aborts acceptance synchronously', async () => {
    const pending = deferred<Buffer>();
    const runList = vi.fn(() => pending.promise);
    const discovery = new WslDiscovery({
      platform: 'win32',
      resolveExecutable: () => 'C:\\Windows\\System32\\wsl.exe',
      runList,
    });
    const first = discovery.getSnapshot();
    const second = discovery.refresh();
    expect(runList).toHaveBeenCalledTimes(1);
    pending.resolve(Buffer.from('Ubuntu\n'));
    await expect(Promise.all([first, second])).resolves.toHaveLength(2);

    const failed = new WslDiscovery({
      platform: 'win32',
      resolveExecutable: () => 'C:\\Windows\\System32\\wsl.exe',
      runList: async () => {
        throw new Error('raw distribution output must not escape');
      },
    });
    await expect(failed.getSnapshot()).resolves.toMatchObject({ status: 'probe-error' });

    const stopping = new WslDiscovery({
      platform: 'win32',
      resolveExecutable: () => 'C:\\Windows\\System32\\wsl.exe',
      runList: async (_executable, signal) =>
        new Promise<Buffer>((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(new Error('raw abort')), {
            once: true,
          });
        }),
    });
    const probe = stopping.getSnapshot();
    stopping.stop();
    await expect(probe).rejects.toThrow('shutting down');
    await expect(stopping.refresh()).rejects.toThrow('shutting down');
  });
});

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}
