import { mkdtemp, readFile, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  SafeStorageCredentialStore,
  type AssistantSafeStorage,
} from '../src/main/assistant/assistant-credential-store';

const API_KEY = `sk-proj-${'a'.repeat(48)}`;
const directories: string[] = [];

afterEach(async () => {
  const { rm } = await import('node:fs/promises');
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })));
});

describe('assistant credential store', () => {
  it('atomically stores only encrypted bytes in a private file', async () => {
    const directory = await temporaryDirectory();
    const store = credentialStore(directory);

    await expect(store.save(API_KEY)).resolves.toMatchObject({
      availability: 'available',
      configured: true,
      removable: true,
      reason: null,
    });
    const files = await import('node:fs/promises').then(({ readdir }) => readdir(directory));
    expect(files).toEqual(['openai-api-key.v1.bin']);
    const bytes = await readFile(join(directory, files[0] ?? ''));
    expect(bytes.includes(Buffer.from(API_KEY))).toBe(false);
    await expect(store.read()).resolves.toBe(API_KEY);
    if (process.platform !== 'win32') {
      expect((await stat(directory)).mode & 0o777).toBe(0o700);
      expect((await stat(join(directory, files[0] ?? ''))).mode & 0o777).toBe(0o600);
    }
  });

  it('rejects Linux basic_text without creating a credential file', async () => {
    const directory = await temporaryDirectory();
    const store = credentialStore(directory, {
      ...fakeSafeStorage(),
      getSelectedStorageBackend: () => 'basic_text',
    });

    await expect(store.getStatus()).resolves.toMatchObject({
      availability: 'unavailable',
      configured: false,
      removable: false,
      reason: 'plaintext-storage',
    });
    await expect(store.save(API_KEY)).rejects.toMatchObject({ reason: 'plaintext-storage' });
  });

  it('distinguishes a corrupt credential from an absent credential and removes it safely', async () => {
    const directory = await temporaryDirectory();
    const store = credentialStore(directory);
    await import('node:fs/promises').then(({ mkdir }) =>
      mkdir(directory, { recursive: true, mode: 0o700 }),
    );
    await writeFile(join(directory, 'openai-api-key.v1.bin'), 'not encrypted');

    await expect(store.getStatus()).resolves.toMatchObject({
      availability: 'available',
      configured: false,
      removable: true,
      reason: 'credential-corrupt',
    });
    await expect(store.read()).rejects.toMatchObject({ reason: 'credential-corrupt' });
    await expect(store.remove()).resolves.toMatchObject({
      availability: 'available',
      configured: false,
      reason: null,
    });
    await expect(store.read()).resolves.toBeNull();
  });

  it('fails closed on a symlink credential without reading its target', async () => {
    const directory = await temporaryDirectory();
    const { mkdir } = await import('node:fs/promises');
    await mkdir(directory, { mode: 0o700 });
    const outside = join(directory, 'outside');
    await writeFile(outside, API_KEY);
    await symlink(outside, join(directory, 'openai-api-key.v1.bin'));
    const store = credentialStore(directory);

    await expect(store.getStatus()).resolves.toMatchObject({
      configured: false,
      removable: true,
      reason: 'credential-corrupt',
    });
    await expect(store.read()).rejects.toMatchObject({ reason: 'credential-corrupt' });
    expect(await readFile(outside, 'utf8')).toBe(API_KEY);
  });

  it('serializes a concurrent save followed by remove so the key cannot reappear', async () => {
    const directory = await temporaryDirectory();
    const store = credentialStore(directory);

    const save = store.save(API_KEY);
    const remove = store.remove();
    await Promise.all([save, remove]);

    await expect(store.getStatus()).resolves.toMatchObject({
      configured: false,
      reason: null,
    });
    await expect(store.read()).resolves.toBeNull();
  });

  it('atomically replaces an existing credential', async () => {
    const directory = await temporaryDirectory();
    const store = credentialStore(directory);
    const replacement = `sk-proj-${'b'.repeat(48)}`;

    await store.save(API_KEY);
    await store.save(replacement);

    await expect(store.read()).resolves.toBe(replacement);
    expect(
      (await readFile(join(directory, 'openai-api-key.v1.bin'))).includes(Buffer.from(API_KEY)),
    ).toBe(false);
  });

  it('allows removal when secure storage becomes unavailable', async () => {
    const directory = await temporaryDirectory();
    await credentialStore(directory).save(API_KEY);
    const unavailable = credentialStore(directory, {
      ...fakeSafeStorage(),
      isEncryptionAvailable: () => false,
    });

    await expect(unavailable.getStatus()).resolves.toMatchObject({
      availability: 'unavailable',
      configured: false,
      removable: true,
      reason: 'secure-storage-unavailable',
    });
    await expect(unavailable.remove()).resolves.toMatchObject({
      availability: 'unavailable',
      configured: false,
      removable: false,
      reason: 'secure-storage-unavailable',
    });
    await expect(credentialStore(directory).read()).resolves.toBeNull();
  });
});

function credentialStore(directory: string, safeStorage = fakeSafeStorage()) {
  return new SafeStorageCredentialStore({
    directory,
    safeStorage,
    platform: 'linux',
    idFactory: () => '11111111-1111-4111-8111-111111111111',
  });
}

function fakeSafeStorage(): AssistantSafeStorage {
  return {
    isEncryptionAvailable: () => true,
    getSelectedStorageBackend: () => 'gnome_libsecret',
    encryptString: (plainText) =>
      Buffer.from(Array.from(Buffer.from(`encrypted:${plainText}`), (value) => value ^ 0xa5)),
    decryptString: (encrypted) => {
      const value = Buffer.from(Array.from(encrypted, (byte) => byte ^ 0xa5)).toString('utf8');
      if (!value.startsWith('encrypted:')) throw new Error('corrupt');
      return value.slice('encrypted:'.length);
    },
  };
}

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'workbench-assistant-credential-'));
  directories.push(directory);
  return join(directory, 'credentials');
}
