import type { Stats } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { TerminalConfigurationService } from '../src/main/terminal/terminal-configuration-service';
import type { TerminalPreferenceStore } from '../src/main/terminal/terminal-preference-types';
import type {
  ResolvedTerminalProfile,
  TerminalProfileResolverLike,
} from '../src/main/terminal/terminal-profile-resolver';
import {
  createWslDistributionId,
  type WslDiscoverySnapshot,
} from '../src/main/terminal/wsl-discovery';
import type { TerminalProfileId } from '../src/shared/contracts';
import type { TerminalHostPlatform } from '../src/shared/terminal-domain';

const WORKSPACE_ID = '11111111-1111-4111-8111-111111111111';

describe('terminal configuration service', () => {
  it('resolves native fixed overrides from a revision-bound snapshot', async () => {
    const preferences = createPreferenceStore({
      preferredProfileId: 'command-prompt',
      nativeCwdPlatform: 'linux',
      nativeCwdPath: '/work/selected',
    });
    const service = new TerminalConfigurationService({
      store: preferences.store,
      profileResolver: createProfileResolver(),
      platform: 'linux',
      homeDirectory: () => '/home/tester',
      fileSystem: createFileSystem({
        directories: ['/home/tester', '/work/selected'],
        files: ['/bin/sh', '/fake/cmd'],
      }),
    });

    const preferred = await service.resolveLaunch({
      workspaceId: WORKSPACE_ID,
      configurationRevision: 1,
    });
    const override = await service.resolveLaunch({
      workspaceId: WORKSPACE_ID,
      configurationRevision: 1,
      profileId: 'system-default',
    });

    expect(preferred.launch).toMatchObject({
      profileId: 'command-prompt',
      executable: '/fake/cmd',
      args: [],
      cwd: '/work/selected',
    });
    expect(override.launch).toMatchObject({
      profileId: 'system-default',
      executable: '/bin/sh',
      args: ['-l'],
      cwd: '/work/selected',
    });
    await expect(
      service.resolveLaunch({
        workspaceId: WORKSPACE_ID,
        configurationRevision: 2,
      }),
    ).rejects.toThrow('settings changed');
  });

  it('launches WSL only with a discovered opaque selection and the host home directory', async () => {
    const revision = 4;
    const name = 'Ubuntu-Dev';
    const id = createWslDistributionId(revision, name);
    const wsl: WslDiscoverySnapshot = {
      status: 'ready',
      capabilityRevision: revision,
      executable: 'C:\\Windows\\System32\\wsl.exe',
      distributions: [{ id, label: name, name }],
    };
    const preferences = createPreferenceStore({
      preferredProfileId: 'wsl-default',
      nativeCwdPlatform: 'win32',
      nativeCwdPath: 'C:\\Projects\\selected',
      wslDistributionName: name,
    });
    const service = new TerminalConfigurationService({
      store: preferences.store,
      profileResolver: createProfileResolver({
        profiles: windowsProfiles(true),
        wsl,
      }),
      platform: 'win32',
      homeDirectory: () => 'C:\\Users\\Tester',
      fileSystem: createFileSystem({
        directories: ['C:\\Users\\Tester', 'C:\\Projects\\selected'],
        files: ['C:\\Windows\\System32\\wsl.exe'],
      }),
    });

    const state = await service.getState(WORKSPACE_ID);
    const resolved = await service.resolveLaunch({
      workspaceId: WORKSPACE_ID,
      configurationRevision: 1,
    });

    expect(state.configuration.wsl).toMatchObject({
      capabilityRevision: revision,
      selectedDistributionId: id,
      selectedDistributionLabel: name,
      selectedDistributionAvailable: true,
    });
    expect(resolved.launch).toMatchObject({
      profileId: 'wsl-default',
      executable: 'C:\\Windows\\System32\\wsl.exe',
      args: ['--distribution', name, '~'],
      cwd: 'C:\\Users\\Tester',
      wslDistributionName: name,
    });
  });

  it('fails closed when settings change during launch resolution', async () => {
    const preferences = createPreferenceStore();
    const accessStarted = deferred<void>();
    const allowAccess = deferred<void>();
    const fileSystem = createFileSystem({
      directories: ['/home/tester'],
      files: ['/bin/sh', '/fake/cmd'],
      access: async (path) => {
        if (path === '/bin/sh') {
          accessStarted.resolve();
          await allowAccess.promise;
        }
      },
    });
    const service = new TerminalConfigurationService({
      store: preferences.store,
      profileResolver: createProfileResolver(),
      platform: 'linux',
      homeDirectory: () => '/home/tester',
      fileSystem,
    });

    const launch = service.resolveLaunch({
      workspaceId: WORKSPACE_ID,
      configurationRevision: 1,
    });
    await accessStarted.promise;
    preferences.replace({
      ...preferences.current(),
      preferredProfileId: 'command-prompt',
      revision: 2,
    });
    allowAccess.resolve();

    await expect(launch).rejects.toThrow('settings changed');
  });

  it('returns the latest state after a cancelled picker and keeps the picker single-flight', async () => {
    const preferences = createPreferenceStore();
    const pickerResult = deferred<string | null>();
    const picker = vi.fn(() => pickerResult.promise);
    const service = new TerminalConfigurationService({
      store: preferences.store,
      profileResolver: createProfileResolver(),
      chooseWorkingDirectory: picker,
      platform: 'linux',
      homeDirectory: () => '/home/tester',
      fileSystem: createFileSystem({
        directories: ['/home/tester'],
        files: ['/bin/sh', '/fake/cmd'],
      }),
    });

    const first = service.chooseWorkingDirectory({
      workspaceId: WORKSPACE_ID,
      expectedRevision: 1,
    });
    await vi.waitFor(() => expect(picker).toHaveBeenCalledTimes(1));
    await expect(
      service.chooseWorkingDirectory({
        workspaceId: WORKSPACE_ID,
        expectedRevision: 1,
      }),
    ).rejects.toThrow('already in progress');
    preferences.replace({
      ...preferences.current(),
      preferredProfileId: 'command-prompt',
      revision: 2,
    });
    pickerResult.resolve(null);

    await expect(first).resolves.toMatchObject({
      status: 'cancelled',
      state: {
        configuration: {
          revision: 2,
          preferredProfileId: 'command-prompt',
        },
      },
    });
  });

  it('validates a picked directory before persistence and rejects Windows non-local paths', async () => {
    const symlinkPreferences = createPreferenceStore();
    const symlinkService = new TerminalConfigurationService({
      store: symlinkPreferences.store,
      profileResolver: createProfileResolver(),
      chooseWorkingDirectory: async () => '/picked/link',
      platform: 'linux',
      homeDirectory: () => '/home/tester',
      fileSystem: createFileSystem({
        directories: ['/home/tester', '/picked/link'],
        files: ['/bin/sh', '/fake/cmd'],
        symlinks: ['/picked/link'],
      }),
    });
    await expect(
      symlinkService.chooseWorkingDirectory({
        workspaceId: WORKSPACE_ID,
        expectedRevision: 1,
      }),
    ).rejects.toThrow('working directory is unavailable');
    expect(
      symlinkPreferences.store.updateTerminalWorkingDirectoryPreference,
    ).not.toHaveBeenCalled();

    const windowsPreferences = createPreferenceStore();
    const windowsService = new TerminalConfigurationService({
      store: windowsPreferences.store,
      profileResolver: createProfileResolver({
        profiles: windowsProfiles(),
        wsl: unsupportedWsl(1),
      }),
      chooseWorkingDirectory: async () => '\\\\server\\share',
      platform: 'win32',
      homeDirectory: () => 'C:\\Users\\Tester',
      fileSystem: createFileSystem({
        directories: ['C:\\Users\\Tester'],
        files: ['C:\\Windows\\System32\\cmd.exe'],
      }),
    });
    await expect(
      windowsService.chooseWorkingDirectory({
        workspaceId: WORKSPACE_ID,
        expectedRevision: 1,
      }),
    ).rejects.toThrow('working directory is unavailable');
    expect(
      windowsPreferences.store.updateTerminalWorkingDirectoryPreference,
    ).not.toHaveBeenCalled();
  });

  it('orders capability refresh ahead of selection writes and rejects the stale opaque id', async () => {
    const preferences = createPreferenceStore();
    const refreshStarted = deferred<void>();
    const allowRefresh = deferred<void>();
    const firstName = 'Ubuntu';
    const secondName = 'Debian';
    let wsl: WslDiscoverySnapshot = readyWsl(1, [firstName]);
    const resolver = createProfileResolver({
      profiles: windowsProfiles(true),
      wsl,
      refresh: async () => {
        refreshStarted.resolve();
        await allowRefresh.promise;
        wsl = readyWsl(2, [secondName]);
      },
      getWsl: () => wsl,
    });
    const service = new TerminalConfigurationService({
      store: preferences.store,
      profileResolver: resolver,
      platform: 'win32',
      homeDirectory: () => 'C:\\Users\\Tester',
      fileSystem: createFileSystem({
        directories: ['C:\\Users\\Tester'],
        files: ['C:\\Windows\\System32\\cmd.exe', 'C:\\Windows\\System32\\wsl.exe'],
      }),
    });

    const refresh = service.refreshCapabilities(WORKSPACE_ID);
    await refreshStarted.promise;
    const staleWrite = service.updateWslDistribution({
      workspaceId: WORKSPACE_ID,
      expectedRevision: 1,
      capabilityRevision: 1,
      distributionId: createWslDistributionId(1, firstName),
    });
    allowRefresh.resolve();

    await expect(refresh).resolves.toMatchObject({
      configuration: { wsl: { capabilityRevision: 2 } },
    });
    await expect(staleWrite).rejects.toThrow('capabilities changed');
    expect(preferences.store.updateTerminalWslDistributionPreference).not.toHaveBeenCalled();
  });

  it('revalidates the executable and refreshed WSL capability before saving a default profile', async () => {
    const nativePreferences = createPreferenceStore();
    const nativeService = new TerminalConfigurationService({
      store: nativePreferences.store,
      profileResolver: createProfileResolver(),
      platform: 'linux',
      homeDirectory: () => '/home/tester',
      fileSystem: createFileSystem({
        directories: ['/home/tester'],
        files: ['/fake/cmd'],
      }),
    });
    await expect(
      nativeService.updateProfile({
        workspaceId: WORKSPACE_ID,
        expectedRevision: 1,
        profileId: 'system-default',
      }),
    ).rejects.toThrow('executable is unavailable');
    expect(nativePreferences.store.updateTerminalProfilePreference).not.toHaveBeenCalled();

    const wslPreferences = createPreferenceStore();
    let wsl = readyWsl(1, ['Ubuntu']);
    const wslService = new TerminalConfigurationService({
      store: wslPreferences.store,
      profileResolver: createProfileResolver({
        profiles: windowsProfiles(true),
        wsl,
        refresh: async () => {
          wsl = readyWsl(2, []);
        },
        getWsl: () => wsl,
      }),
      platform: 'win32',
      homeDirectory: () => 'C:\\Users\\Tester',
      fileSystem: createFileSystem({
        directories: ['C:\\Users\\Tester'],
        files: ['C:\\Windows\\System32\\cmd.exe', 'C:\\Windows\\System32\\wsl.exe'],
      }),
    });
    await expect(
      wslService.updateProfile({
        workspaceId: WORKSPACE_ID,
        expectedRevision: 1,
        profileId: 'wsl-default',
      }),
    ).rejects.toThrow('selected WSL distribution is unavailable');
    expect(wslPreferences.store.updateTerminalProfilePreference).not.toHaveBeenCalled();
  });

  it('stops acceptance before a pending picker or capability probe can persist data', async () => {
    const preferences = createPreferenceStore();
    const picker = deferred<string | null>();
    const service = new TerminalConfigurationService({
      store: preferences.store,
      profileResolver: createProfileResolver(),
      chooseWorkingDirectory: () => picker.promise,
      platform: 'linux',
      homeDirectory: () => '/home/tester',
      fileSystem: createFileSystem({
        directories: ['/home/tester', '/picked'],
        files: ['/bin/sh', '/fake/cmd'],
      }),
    });
    const selection = service.chooseWorkingDirectory({
      workspaceId: WORKSPACE_ID,
      expectedRevision: 1,
    });
    await vi.waitFor(() => expect(preferences.store.getTerminalPreferences).toHaveBeenCalled());
    service.stop();
    picker.resolve('/picked');

    await expect(selection).rejects.toThrow('shutting down');
    expect(preferences.store.updateTerminalWorkingDirectoryPreference).not.toHaveBeenCalled();
    await expect(service.getState(WORKSPACE_ID)).rejects.toThrow('shutting down');
  });
});

function createPreferenceStore(overrides: Partial<StoredPreferences> = {}): {
  store: TerminalPreferenceStore & {
    getTerminalPreferences: ReturnType<typeof vi.fn>;
    updateTerminalProfilePreference: ReturnType<typeof vi.fn>;
    updateTerminalWorkingDirectoryPreference: ReturnType<typeof vi.fn>;
    updateTerminalWslDistributionPreference: ReturnType<typeof vi.fn>;
  };
  current(): StoredPreferences;
  replace(value: StoredPreferences): void;
} {
  let current: StoredPreferences = {
    workspaceId: WORKSPACE_ID,
    preferredProfileId: 'system-default',
    nativeCwdPlatform: null,
    nativeCwdPath: null,
    wslDistributionName: null,
    revision: 1,
    updatedAt: '2026-07-23T00:00:00.000Z',
    ...overrides,
  };
  const assertRevision = (expectedRevision: number): void => {
    if (current.revision !== expectedRevision) throw new Error('preference CAS failed');
  };
  const store = {
    getTerminalPreferences: vi.fn(async () => ({ ...current })),
    updateTerminalProfilePreference: vi.fn(
      async (input: { preferredProfileId: TerminalProfileId; expectedRevision: number }) => {
        assertRevision(input.expectedRevision);
        current = {
          ...current,
          preferredProfileId: input.preferredProfileId,
          revision: current.revision + 1,
        };
        return { ...current };
      },
    ),
    updateTerminalWorkingDirectoryPreference: vi.fn(
      async (input: {
        nativeCwdPlatform: TerminalHostPlatform | null;
        nativeCwdPath: string | null;
        expectedRevision: number;
      }) => {
        assertRevision(input.expectedRevision);
        current = {
          ...current,
          nativeCwdPlatform: input.nativeCwdPlatform,
          nativeCwdPath: input.nativeCwdPath,
          revision: current.revision + 1,
        };
        return { ...current };
      },
    ),
    updateTerminalWslDistributionPreference: vi.fn(
      async (input: { wslDistributionName: string | null; expectedRevision: number }) => {
        assertRevision(input.expectedRevision);
        current = {
          ...current,
          wslDistributionName: input.wslDistributionName,
          revision: current.revision + 1,
        };
        return { ...current };
      },
    ),
  };
  return {
    store,
    current: () => ({ ...current }),
    replace: (value) => {
      current = { ...value };
    },
  };
}

interface StoredPreferences {
  readonly workspaceId: string;
  readonly preferredProfileId: TerminalProfileId;
  readonly nativeCwdPlatform: TerminalHostPlatform | null;
  readonly nativeCwdPath: string | null;
  readonly wslDistributionName: string | null;
  readonly revision: number;
  readonly updatedAt: string;
}

function createProfileResolver(
  options: {
    profiles?: readonly ResolvedTerminalProfile[];
    wsl?: WslDiscoverySnapshot;
    refresh?: () => Promise<void>;
    getWsl?: () => WslDiscoverySnapshot;
  } = {},
): TerminalProfileResolverLike {
  const profiles = options.profiles ?? linuxProfiles();
  let wsl = options.wsl ?? unsupportedWsl(1);
  return {
    listProfiles: vi.fn(async (input) => {
      if (input?.refresh) {
        await options.refresh?.();
        wsl = options.getWsl?.() ?? wsl;
      }
      return profiles;
    }),
    getWslSnapshot: vi.fn(async () => options.getWsl?.() ?? wsl),
    stop: vi.fn(),
  };
}

function linuxProfiles(): readonly ResolvedTerminalProfile[] {
  return [
    profile('system-default', 'System Shell', 'system', '/bin/sh', ['-l'], true),
    profile('command-prompt', 'Command Prompt', 'command-prompt', '/fake/cmd', []),
    profile('wsl-default', 'WSL 默认发行版', 'wsl', undefined, []),
  ];
}

function windowsProfiles(wslAvailable = false): readonly ResolvedTerminalProfile[] {
  return [
    profile(
      'system-default',
      'Command Prompt',
      'system',
      'C:\\Windows\\System32\\cmd.exe',
      [],
      true,
    ),
    profile(
      'wsl-default',
      'WSL 默认发行版',
      'wsl',
      wslAvailable ? 'C:\\Windows\\System32\\wsl.exe' : undefined,
      wslAvailable ? ['~'] : [],
    ),
  ];
}

function profile(
  id: TerminalProfileId,
  label: string,
  kind: ResolvedTerminalProfile['profile']['kind'],
  executable: string | undefined,
  args: readonly string[],
  isDefault = false,
): ResolvedTerminalProfile {
  return {
    profile: {
      id,
      label,
      kind,
      isDefault,
      available: executable !== undefined,
      ...(executable ? {} : { unavailableReason: 'unavailable' }),
    },
    executable,
    args,
  };
}

function unsupportedWsl(capabilityRevision: number): WslDiscoverySnapshot {
  return {
    status: 'unsupported',
    capabilityRevision,
    distributions: [],
  };
}

function readyWsl(capabilityRevision: number, names: readonly string[]): WslDiscoverySnapshot {
  return {
    status: names.length === 0 ? 'no-distributions' : 'ready',
    capabilityRevision,
    executable: 'C:\\Windows\\System32\\wsl.exe',
    distributions: names.map((name) => ({
      id: createWslDistributionId(capabilityRevision, name),
      label: name,
      name,
    })),
  };
}

function createFileSystem(options: {
  readonly directories: readonly string[];
  readonly files: readonly string[];
  readonly symlinks?: readonly string[];
  readonly realPaths?: Readonly<Record<string, string>>;
  readonly access?: (path: string) => Promise<void>;
}) {
  const directories = new Set(options.directories);
  const files = new Set(options.files);
  const symlinks = new Set(options.symlinks ?? []);
  const metadata = (path: string): Stats => {
    if (!directories.has(path) && !files.has(path)) throw new Error('missing fixture');
    return {
      isDirectory: () => directories.has(path),
      isFile: () => files.has(path),
      isSymbolicLink: () => symlinks.has(path),
    } as Stats;
  };
  return {
    lstat: vi.fn(async (path: string) => metadata(path)),
    stat: vi.fn(async (path: string) => metadata(path)),
    realpath: vi.fn(async (path: string) => options.realPaths?.[path] ?? path),
    access: vi.fn(async (path: string) => options.access?.(path)),
  };
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}
