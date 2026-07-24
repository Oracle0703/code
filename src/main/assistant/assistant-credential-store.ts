import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { chmod, lstat, mkdir, open, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { AssistantCredentialReason, AssistantCredentialStatus } from '../../shared/contracts';
import {
  ASSISTANT_MODEL,
  ASSISTANT_PROVIDER,
  normalizeAssistantApiKey,
} from '../../shared/assistant-domain';
import { AssistantCredentialError } from './assistant-errors';

const CREDENTIAL_FILE_NAME = 'openai-api-key.v1.bin';
const MAX_ENCRYPTED_CREDENTIAL_BYTES = 64 * 1_024;

export interface AssistantSafeStorage {
  isEncryptionAvailable(): boolean;
  getSelectedStorageBackend(): string;
  encryptString(plainText: string): Buffer;
  decryptString(encrypted: Buffer): string;
}

export interface AssistantCredentialStore {
  getStatus(): Promise<AssistantCredentialStatus>;
  read(): Promise<string | null>;
  save(apiKey: string): Promise<AssistantCredentialStatus>;
  remove(): Promise<AssistantCredentialStatus>;
}

export interface SafeStorageCredentialStoreOptions {
  readonly directory: string;
  readonly safeStorage: AssistantSafeStorage;
  readonly platform?: NodeJS.Platform;
  readonly idFactory?: () => string;
}

export class SafeStorageCredentialStore implements AssistantCredentialStore {
  readonly #directory: string;
  readonly #credentialPath: string;
  readonly #safeStorage: AssistantSafeStorage;
  readonly #platform: NodeJS.Platform;
  readonly #idFactory: () => string;
  #operationQueue: Promise<void> = Promise.resolve();

  constructor({
    directory,
    safeStorage,
    platform = process.platform,
    idFactory = randomUUID,
  }: SafeStorageCredentialStoreOptions) {
    this.#directory = directory;
    this.#credentialPath = join(directory, CREDENTIAL_FILE_NAME);
    this.#safeStorage = safeStorage;
    this.#platform = platform;
    this.#idFactory = idFactory;
  }

  getStatus(): Promise<AssistantCredentialStatus> {
    return this.#serialize(async () => this.#statusUnlocked());
  }

  read(): Promise<string | null> {
    return this.#serialize(async () => {
      this.#requireSecureStorage();
      return this.#readUnlocked();
    });
  }

  save(apiKey: string): Promise<AssistantCredentialStatus> {
    return this.#serialize(async () => {
      const normalized = normalizeAssistantApiKey(apiKey);
      this.#requireSecureStorage();
      await this.#prepareDirectory();
      let encrypted: Buffer;
      try {
        encrypted = this.#safeStorage.encryptString(normalized);
      } catch {
        throw new AssistantCredentialError(
          'secure-storage-unavailable',
          'Secure credential encryption is unavailable.',
        );
      }
      if (encrypted.length < 1 || encrypted.length > MAX_ENCRYPTED_CREDENTIAL_BYTES) {
        encrypted.fill(0);
        throw new AssistantCredentialError(
          'credential-corrupt',
          'Secure credential encryption returned invalid data.',
        );
      }

      const temporaryPath = join(
        this.#directory,
        `.${CREDENTIAL_FILE_NAME}.${this.#idFactory()}.partial`,
      );
      try {
        const handle = await open(temporaryPath, 'wx', 0o600);
        try {
          await handle.writeFile(encrypted);
          await handle.sync();
        } finally {
          await handle.close();
        }
        if (this.#platform !== 'win32') await chmod(temporaryPath, 0o600);
        await rename(temporaryPath, this.#credentialPath);
        if (this.#platform !== 'win32') await chmod(this.#credentialPath, 0o600);
      } finally {
        encrypted.fill(0);
        await rm(temporaryPath, { force: true }).catch(() => undefined);
      }
      return this.#status(true, null, true);
    });
  }

  remove(): Promise<AssistantCredentialStatus> {
    return this.#serialize(async () => {
      try {
        const directoryMetadata = await lstat(this.#directory);
        if (!directoryMetadata.isDirectory() || directoryMetadata.isSymbolicLink()) {
          throw new AssistantCredentialError(
            'credential-corrupt',
            'The private credential directory is invalid.',
          );
        }
      } catch (error) {
        if (!hasErrorCode(error, 'ENOENT')) throw error;
      }
      await rm(this.#credentialPath, { force: true });
      const reason = this.#availabilityReason();
      return this.#status(false, reason, false);
    });
  }

  #serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#operationQueue.then(operation, operation);
    this.#operationQueue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  async #statusUnlocked(): Promise<AssistantCredentialStatus> {
    const reason = this.#availabilityReason();
    if (reason) {
      return this.#status(false, reason, await this.#hasRemovableCredentialUnlocked());
    }
    try {
      const configured = (await this.#readUnlocked()) !== null;
      return this.#status(configured, null, configured);
    } catch (error) {
      if (error instanceof AssistantCredentialError && error.reason === 'credential-corrupt') {
        return this.#status(
          false,
          'credential-corrupt',
          await this.#hasRemovableCredentialUnlocked(),
        );
      }
      throw error;
    }
  }

  #availabilityReason(): Exclude<AssistantCredentialReason, 'credential-corrupt' | null> | null {
    let available: boolean;
    try {
      available = this.#safeStorage.isEncryptionAvailable();
    } catch {
      return 'secure-storage-unavailable';
    }
    if (!available) return 'secure-storage-unavailable';
    if (this.#platform === 'linux') {
      try {
        if (this.#safeStorage.getSelectedStorageBackend() === 'basic_text') {
          return 'plaintext-storage';
        }
      } catch {
        return 'secure-storage-unavailable';
      }
    }
    return null;
  }

  #requireSecureStorage(): void {
    const reason = this.#availabilityReason();
    if (reason) {
      throw new AssistantCredentialError(
        reason,
        reason === 'plaintext-storage'
          ? 'Plaintext credential storage is not allowed.'
          : 'Secure credential storage is unavailable.',
      );
    }
  }

  async #readUnlocked(): Promise<string | null> {
    let directoryMetadata;
    try {
      directoryMetadata = await lstat(this.#directory);
    } catch (error) {
      if (hasErrorCode(error, 'ENOENT')) return null;
      throw new AssistantCredentialError(
        'credential-corrupt',
        'The private credential directory could not be inspected.',
      );
    }
    if (!directoryMetadata.isDirectory() || directoryMetadata.isSymbolicLink()) {
      throw new AssistantCredentialError(
        'credential-corrupt',
        'The private credential directory is invalid.',
      );
    }

    let metadata;
    try {
      metadata = await lstat(this.#credentialPath);
    } catch (error) {
      if (hasErrorCode(error, 'ENOENT')) return null;
      throw new AssistantCredentialError(
        'credential-corrupt',
        'The encrypted credential could not be inspected.',
      );
    }
    if (
      !metadata.isFile() ||
      metadata.isSymbolicLink() ||
      metadata.size < 1 ||
      metadata.size > MAX_ENCRYPTED_CREDENTIAL_BYTES
    ) {
      throw new AssistantCredentialError(
        'credential-corrupt',
        'The encrypted credential file is invalid.',
      );
    }

    let encrypted: Buffer | undefined;
    try {
      const handle = await open(this.#credentialPath, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const openedMetadata = await handle.stat();
        if (
          !openedMetadata.isFile() ||
          openedMetadata.size < 1 ||
          openedMetadata.size > MAX_ENCRYPTED_CREDENTIAL_BYTES
        ) {
          throw new AssistantCredentialError(
            'credential-corrupt',
            'The encrypted credential file is invalid.',
          );
        }
        encrypted = await handle.readFile();
      } finally {
        await handle.close();
      }
      const decrypted = this.#safeStorage.decryptString(encrypted);
      return normalizeAssistantApiKey(decrypted);
    } catch (error) {
      if (error instanceof AssistantCredentialError) throw error;
      throw new AssistantCredentialError(
        'credential-corrupt',
        'The encrypted credential could not be decrypted.',
      );
    } finally {
      encrypted?.fill(0);
    }
  }

  async #prepareDirectory(): Promise<void> {
    try {
      await mkdir(this.#directory, { recursive: true, mode: 0o700 });
      const metadata = await lstat(this.#directory);
      if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
        throw new Error('Credential directory is not a private directory.');
      }
      if (this.#platform !== 'win32') await chmod(this.#directory, 0o700);
    } catch {
      throw new AssistantCredentialError(
        'secure-storage-unavailable',
        'The private credential directory is unavailable.',
      );
    }
  }

  #status(
    configured: boolean,
    reason: AssistantCredentialReason,
    removable: boolean,
  ): AssistantCredentialStatus {
    return {
      availability:
        reason === 'secure-storage-unavailable' || reason === 'plaintext-storage'
          ? 'unavailable'
          : 'available',
      configured,
      removable,
      provider: ASSISTANT_PROVIDER,
      model: ASSISTANT_MODEL,
      reason,
    };
  }

  async #hasRemovableCredentialUnlocked(): Promise<boolean> {
    try {
      const directoryMetadata = await lstat(this.#directory);
      if (!directoryMetadata.isDirectory() || directoryMetadata.isSymbolicLink()) return false;
      const credentialMetadata = await lstat(this.#credentialPath);
      return credentialMetadata.isFile() || credentialMetadata.isSymbolicLink();
    } catch {
      return false;
    }
  }
}

function hasErrorCode(error: unknown, code: string): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { readonly code?: unknown }).code === code
  );
}
