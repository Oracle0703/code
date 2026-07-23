import { constants } from 'node:fs';
import {
  access as accessFile,
  lstat as inspectLink,
  realpath as resolveRealPath,
  stat as inspectFile,
} from 'node:fs/promises';
import { homedir } from 'node:os';
import { posix, win32 } from 'node:path';
import type { Stats } from 'node:fs';
import type {
  TerminalConfigurationRevisionInput,
  TerminalConfigurationSnapshot,
  TerminalProfileId,
  TerminalProfileKind,
  TerminalProfilePreferenceInput,
  TerminalWslPreferenceInput,
} from '../../shared/contracts';
import {
  normalizeStoredTerminalPath,
  normalizeTerminalPreferenceRevision,
  normalizeTerminalProfileId,
  normalizeWslDistributionId,
  type TerminalHostPlatform,
} from '../../shared/terminal-domain';
import type {
  StoredTerminalPreferences,
  TerminalPreferenceStore,
} from './terminal-preference-types';
import {
  TerminalProfileResolver,
  type ResolvedTerminalProfile,
  type TerminalProfileResolverLike,
} from './terminal-profile-resolver';
import { createWslDistributionId, type WslDiscoverySnapshot } from './wsl-discovery';

export interface TerminalConfigurationState {
  readonly profiles: readonly ResolvedTerminalProfile[];
  readonly configuration: TerminalConfigurationSnapshot;
}

export interface TerminalLaunchConfiguration {
  readonly profileId: TerminalProfileId;
  readonly profileKind: TerminalProfileKind;
  readonly label: string;
  readonly executable: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly wslDistributionName: string | null;
}

export interface ResolvedTerminalLaunch {
  readonly state: TerminalConfigurationState;
  readonly launch: TerminalLaunchConfiguration;
}

export type TerminalDirectoryPicker = () => Promise<string | null>;

interface FileSystemAccess {
  lstat(path: string): Promise<Stats>;
  stat(path: string): Promise<Stats>;
  realpath(path: string): Promise<string>;
  access(path: string, mode: number): Promise<void>;
}

export interface TerminalConfigurationServiceOptions {
  readonly store: TerminalPreferenceStore;
  readonly profileResolver?: TerminalProfileResolverLike;
  readonly chooseWorkingDirectory?: TerminalDirectoryPicker;
  readonly platform?: NodeJS.Platform;
  readonly homeDirectory?: () => string;
  readonly fileSystem?: FileSystemAccess;
}

export interface TerminalConfigurationServiceLike {
  getState(
    workspaceId: string,
    options?: { readonly refreshCapabilities?: boolean },
  ): Promise<TerminalConfigurationState>;
  resolveLaunch(input: {
    readonly workspaceId: string;
    readonly configurationRevision: number;
    readonly profileId?: TerminalProfileId;
  }): Promise<ResolvedTerminalLaunch>;
  revalidateLaunch(
    workspaceId: string,
    launch: TerminalLaunchConfiguration,
  ): Promise<TerminalConfigurationState>;
  updateProfile(input: TerminalProfilePreferenceInput): Promise<TerminalConfigurationState>;
  updateWslDistribution(input: TerminalWslPreferenceInput): Promise<TerminalConfigurationState>;
  chooseWorkingDirectory(
    input: TerminalConfigurationRevisionInput,
  ): Promise<
    | { readonly status: 'cancelled'; readonly state: TerminalConfigurationState }
    | { readonly status: 'updated'; readonly state: TerminalConfigurationState }
  >;
  resetWorkingDirectory(
    input: TerminalConfigurationRevisionInput,
  ): Promise<TerminalConfigurationState>;
  refreshCapabilities(workspaceId: string): Promise<TerminalConfigurationState>;
  stop(): void;
}

interface OperationToken {
  readonly generation: number;
}

const DEFAULT_FILE_SYSTEM: FileSystemAccess = {
  lstat: inspectLink,
  stat: inspectFile,
  realpath: resolveRealPath,
  access: accessFile,
};

export class TerminalConfigurationService implements TerminalConfigurationServiceLike {
  readonly #store: TerminalPreferenceStore;
  readonly #profileResolver: TerminalProfileResolverLike;
  readonly #chooseWorkingDirectory: TerminalDirectoryPicker;
  readonly #platform: NodeJS.Platform;
  readonly #homeDirectory: () => string;
  readonly #fileSystem: FileSystemAccess;
  #accepting = true;
  #generation = 0;
  #pickerInFlight = false;
  #capabilityQueue: Promise<void> = Promise.resolve();

  public constructor({
    store,
    profileResolver = new TerminalProfileResolver(),
    chooseWorkingDirectory = async () => null,
    platform = process.platform,
    homeDirectory = homedir,
    fileSystem = DEFAULT_FILE_SYSTEM,
  }: TerminalConfigurationServiceOptions) {
    this.#store = store;
    this.#profileResolver = profileResolver;
    this.#chooseWorkingDirectory = chooseWorkingDirectory;
    this.#platform = platform;
    this.#homeDirectory = homeDirectory;
    this.#fileSystem = fileSystem;
  }

  public async getState(
    workspaceId: string,
    options: { readonly refreshCapabilities?: boolean } = {},
  ): Promise<TerminalConfigurationState> {
    if (options.refreshCapabilities) {
      return this.#withCapabilityOrder(async () => {
        const token = this.#captureOperation();
        const preferences = await this.#store.getTerminalPreferences(workspaceId);
        this.#assertOperation(token);
        return this.#readState(preferences, true, token);
      });
    }
    const token = this.#captureOperation();
    const preferences = await this.#store.getTerminalPreferences(workspaceId);
    this.#assertOperation(token);
    return this.#readState(preferences, false, token);
  }

  public async resolveLaunch(input: {
    readonly workspaceId: string;
    readonly configurationRevision: number;
    readonly profileId?: TerminalProfileId;
  }): Promise<ResolvedTerminalLaunch> {
    const token = this.#captureOperation();
    const configurationRevision = normalizeTerminalPreferenceRevision(input.configurationRevision);
    const preferences = await this.#store.getTerminalPreferences(input.workspaceId);
    this.#assertOperation(token);
    if (preferences.revision !== configurationRevision) {
      throw new Error('Terminal settings changed before the session could be created.');
    }
    const profileId =
      input.profileId === undefined
        ? preferences.preferredProfileId
        : normalizeTerminalProfileId(input.profileId);
    const state = await this.#readState(preferences, false, token);
    const profile = findProfile(state.profiles, profileId);
    if (profile.profile.kind === 'wsl') {
      return this.#withCapabilityOrder(async () => {
        const refreshedState = await this.#readState(preferences, true, token);
        const refreshedProfile = findProfile(refreshedState.profiles, profileId);
        const launch = await this.#createLaunch(
          preferences,
          refreshedProfile,
          refreshedState,
          token,
        );
        this.#assertOperation(token);
        await this.#assertPreferencesUnchanged(input.workspaceId, preferences, token);
        return freezeResolvedLaunch(refreshedState, launch);
      });
    }
    const launch = await this.#createLaunch(preferences, profile, state, token);
    this.#assertOperation(token);
    await this.#assertPreferencesUnchanged(input.workspaceId, preferences, token);
    return freezeResolvedLaunch(state, launch);
  }

  public async revalidateLaunch(
    workspaceId: string,
    launch: TerminalLaunchConfiguration,
  ): Promise<TerminalConfigurationState> {
    const token = this.#captureOperation();
    const preferences = await this.#store.getTerminalPreferences(workspaceId);
    this.#assertOperation(token);
    const validate = async (refreshCapabilities: boolean): Promise<TerminalConfigurationState> => {
      const state = await this.#readState(preferences, refreshCapabilities, token);
      const executable = await this.#requireExecutable(launch.executable, token);
      if (!samePath(executable, launch.executable, this.#platform)) {
        throw new Error('The terminal executable changed before restart.');
      }
      const cwd = await this.#requireDirectory(launch.cwd, token);
      if (!samePath(cwd, launch.cwd, this.#platform)) {
        throw new Error('The terminal working directory changed before restart.');
      }
      if (launch.profileKind === 'wsl') {
        const wsl = await this.#profileResolver.getWslSnapshot();
        this.#assertOperation(token);
        if (wsl.status !== 'ready' || !wsl.executable) {
          throw new Error('The WSL capability is no longer available.');
        }
        const currentExecutable = await this.#requireExecutable(wsl.executable, token);
        if (!samePath(currentExecutable, launch.executable, this.#platform)) {
          throw new Error('The WSL executable changed before restart.');
        }
        if (
          launch.wslDistributionName !== null &&
          !wsl.distributions.some(({ name }) => name === launch.wslDistributionName)
        ) {
          throw new Error('The selected WSL distribution is no longer available.');
        }
        const expectedArgs =
          launch.wslDistributionName === null
            ? ['~']
            : ['--distribution', launch.wslDistributionName, '~'];
        if (!sameArguments(launch.args, expectedArgs)) {
          throw new Error('The WSL launch configuration is invalid.');
        }
      }
      this.#assertOperation(token);
      return state;
    };
    return launch.profileKind === 'wsl'
      ? this.#withCapabilityOrder(() => validate(true))
      : validate(false);
  }

  public async updateProfile(
    input: TerminalProfilePreferenceInput,
  ): Promise<TerminalConfigurationState> {
    const profileId = normalizeTerminalProfileId(input.profileId);
    const update = async (refreshCapabilities: boolean): Promise<TerminalConfigurationState> => {
      const token = this.#captureOperation();
      const current = await this.#store.getTerminalPreferences(input.workspaceId);
      this.#assertOperation(token);
      if (current.revision !== normalizeTerminalPreferenceRevision(input.expectedRevision)) {
        throw new Error('Terminal settings changed before the profile could be updated.');
      }
      const state = await this.#readState(current, refreshCapabilities, token);
      const profile = findProfile(state.profiles, profileId);
      if (!profile.profile.available || !profile.executable) {
        throw new Error(
          profile.profile.unavailableReason ?? 'The terminal profile is unavailable.',
        );
      }
      await this.#requireExecutable(profile.executable, token);
      if (
        profile.profile.kind === 'wsl' &&
        !state.configuration.wsl.selectedDistributionAvailable
      ) {
        throw new Error('The selected WSL distribution is unavailable.');
      }
      const updated = await this.#store.updateTerminalProfilePreference({
        workspaceId: input.workspaceId,
        preferredProfileId: profileId,
        expectedRevision: current.revision,
      });
      this.#assertOperation(token);
      return this.#readState(updated, false, token);
    };
    return profileId === 'wsl-default'
      ? this.#withCapabilityOrder(() => update(true))
      : update(false);
  }

  public async updateWslDistribution(
    input: TerminalWslPreferenceInput,
  ): Promise<TerminalConfigurationState> {
    return this.#withCapabilityOrder(async () => {
      const token = this.#captureOperation();
      const expectedRevision = normalizeTerminalPreferenceRevision(input.expectedRevision);
      const capabilityRevision = normalizeTerminalPreferenceRevision(input.capabilityRevision);
      const current = await this.#store.getTerminalPreferences(input.workspaceId);
      this.#assertOperation(token);
      if (current.revision !== expectedRevision) {
        throw new Error('Terminal settings changed before the WSL selection could be updated.');
      }
      const wsl = await this.#profileResolver.getWslSnapshot();
      this.#assertOperation(token);
      if (wsl.capabilityRevision !== capabilityRevision || wsl.status !== 'ready') {
        throw new Error('WSL capabilities changed before the selection could be updated.');
      }
      let wslDistributionName: string | null = null;
      if (input.distributionId !== null) {
        const distributionId = normalizeWslDistributionId(input.distributionId);
        const distribution = wsl.distributions.find(({ id }) => id === distributionId);
        if (!distribution) {
          throw new Error('The selected WSL distribution is not available.');
        }
        wslDistributionName = distribution.name;
      }
      const updated = await this.#store.updateTerminalWslDistributionPreference({
        workspaceId: input.workspaceId,
        wslDistributionName,
        expectedRevision: current.revision,
      });
      this.#assertOperation(token);
      return this.#readState(updated, false, token);
    });
  }

  public async chooseWorkingDirectory(
    input: TerminalConfigurationRevisionInput,
  ): Promise<
    | { readonly status: 'cancelled'; readonly state: TerminalConfigurationState }
    | { readonly status: 'updated'; readonly state: TerminalConfigurationState }
  > {
    if (this.#pickerInFlight) {
      throw new Error('A terminal working-directory selection is already in progress.');
    }
    this.#pickerInFlight = true;
    try {
      const token = this.#captureOperation();
      const expectedRevision = normalizeTerminalPreferenceRevision(input.expectedRevision);
      const current = await this.#store.getTerminalPreferences(input.workspaceId);
      this.#assertOperation(token);
      if (current.revision !== expectedRevision) {
        throw new Error('Terminal settings changed before the directory could be selected.');
      }

      const selectedPath = await this.#chooseWorkingDirectory();
      this.#assertOperation(token);
      if (selectedPath === null) {
        const latest = await this.#store.getTerminalPreferences(input.workspaceId);
        this.#assertOperation(token);
        return Object.freeze({
          status: 'cancelled',
          state: await this.#readState(latest, false, token),
        });
      }
      const directory = await this.#requireDirectory(selectedPath, token);
      const updated = await this.#store.updateTerminalWorkingDirectoryPreference({
        workspaceId: input.workspaceId,
        nativeCwdPlatform: requireHostPlatform(this.#platform),
        nativeCwdPath: directory,
        expectedRevision: current.revision,
      });
      this.#assertOperation(token);
      return Object.freeze({
        status: 'updated',
        state: await this.#readState(updated, false, token),
      });
    } finally {
      this.#pickerInFlight = false;
    }
  }

  public async resetWorkingDirectory(
    input: TerminalConfigurationRevisionInput,
  ): Promise<TerminalConfigurationState> {
    const token = this.#captureOperation();
    const expectedRevision = normalizeTerminalPreferenceRevision(input.expectedRevision);
    const updated = await this.#store.updateTerminalWorkingDirectoryPreference({
      workspaceId: input.workspaceId,
      nativeCwdPlatform: null,
      nativeCwdPath: null,
      expectedRevision,
    });
    this.#assertOperation(token);
    return this.#readState(updated, false, token);
  }

  public async refreshCapabilities(workspaceId: string): Promise<TerminalConfigurationState> {
    return this.getState(workspaceId, { refreshCapabilities: true });
  }

  public stop(): void {
    if (!this.#accepting) return;
    this.#accepting = false;
    this.#generation += 1;
    this.#profileResolver.stop();
  }

  async #readState(
    preferences: StoredTerminalPreferences,
    refreshCapabilities: boolean,
    token: OperationToken,
  ): Promise<TerminalConfigurationState> {
    let profiles: readonly ResolvedTerminalProfile[];
    let wsl: WslDiscoverySnapshot;
    try {
      profiles = await this.#profileResolver.listProfiles({
        refresh: refreshCapabilities,
      });
      this.#assertOperation(token);
      wsl = await this.#profileResolver.getWslSnapshot();
      this.#assertOperation(token);
    } catch {
      this.#assertOperation(token);
      throw new Error('Unable to discover terminal capabilities.');
    }
    const workingDirectory = await this.#inspectWorkingDirectory(preferences, token);
    this.#assertOperation(token);
    return freezeState({
      profiles,
      configuration: {
        revision: preferences.revision,
        preferredProfileId: preferences.preferredProfileId,
        workingDirectory,
        wsl: publicWslConfiguration(preferences, wsl),
      },
    });
  }

  async #createLaunch(
    preferences: StoredTerminalPreferences,
    profile: ResolvedTerminalProfile,
    state: TerminalConfigurationState,
    token: OperationToken,
  ): Promise<TerminalLaunchConfiguration> {
    if (!profile.profile.available || !profile.executable) {
      throw new Error(profile.profile.unavailableReason ?? 'The terminal profile is unavailable.');
    }
    const executable = await this.#requireExecutable(profile.executable, token);
    const cwd =
      profile.profile.kind === 'wsl'
        ? await this.#requireDirectory(this.#homeDirectory(), token)
        : await this.#requireConfiguredWorkingDirectory(preferences, token);
    let args = [...profile.args];
    let wslDistributionName: string | null = null;
    if (profile.profile.kind === 'wsl') {
      if (!state.configuration.wsl.selectedDistributionAvailable) {
        throw new Error('The selected WSL distribution is unavailable.');
      }
      const wsl = await this.#profileResolver.getWslSnapshot();
      this.#assertOperation(token);
      if (wsl.status !== 'ready' || !wsl.executable) {
        throw new Error('The WSL capability is unavailable.');
      }
      if (preferences.wslDistributionName !== null) {
        const distribution = wsl.distributions.find(
          ({ name }) => name === preferences.wslDistributionName,
        );
        if (!distribution) {
          throw new Error('The selected WSL distribution is unavailable.');
        }
        wslDistributionName = distribution.name;
        args = ['--distribution', distribution.name, '~'];
      } else {
        args = ['~'];
      }
    }
    return Object.freeze({
      profileId: profile.profile.id,
      profileKind: profile.profile.kind,
      label: profile.profile.label,
      executable,
      args: Object.freeze(args),
      cwd,
      wslDistributionName,
    });
  }

  async #inspectWorkingDirectory(
    preferences: StoredTerminalPreferences,
    token: OperationToken,
  ): Promise<TerminalConfigurationSnapshot['workingDirectory']> {
    const selected = preferences.nativeCwdPath !== null;
    const displayPath = selected ? preferences.nativeCwdPath : this.#homeDirectory();
    if (
      selected &&
      preferences.nativeCwdPlatform !== null &&
      preferences.nativeCwdPlatform !== this.#platform
    ) {
      return Object.freeze({
        mode: 'selected-directory',
        displayPath,
        available: false,
        unavailableReason: '这个目录属于另一种主机平台，请重新选择。',
      });
    }
    try {
      const directory = await this.#requireDirectory(displayPath, token);
      return Object.freeze({
        mode: selected ? 'selected-directory' : 'user-home',
        displayPath: directory,
        available: true,
      });
    } catch {
      this.#assertOperation(token);
      return Object.freeze({
        mode: selected ? 'selected-directory' : 'user-home',
        displayPath,
        available: false,
        unavailableReason: selected ? '选择的终端启动目录当前不可用。' : '用户主目录当前不可用。',
      });
    }
  }

  async #requireConfiguredWorkingDirectory(
    preferences: StoredTerminalPreferences,
    token: OperationToken,
  ): Promise<string> {
    if (preferences.nativeCwdPath !== null && preferences.nativeCwdPlatform !== this.#platform) {
      throw new Error('The selected terminal working directory belongs to another platform.');
    }
    return this.#requireDirectory(preferences.nativeCwdPath ?? this.#homeDirectory(), token);
  }

  async #requireDirectory(candidate: string, token: OperationToken): Promise<string> {
    try {
      return await this.#resolveDirectory(candidate, token);
    } catch {
      this.#assertOperation(token);
      throw new Error('The terminal working directory is unavailable.');
    }
  }

  async #resolveDirectory(candidate: string, token: OperationToken): Promise<string> {
    const normalized = normalizeStoredTerminalPath(candidate);
    assertLocalAbsolutePath(normalized, this.#platform);
    const link = await this.#fileSystem.lstat(normalized);
    this.#assertOperation(token);
    if (link.isSymbolicLink()) {
      throw new Error('The terminal working directory cannot be a symbolic link.');
    }
    const metadata = await this.#fileSystem.stat(normalized);
    this.#assertOperation(token);
    if (!metadata.isDirectory()) {
      throw new Error('The terminal working directory is not a directory.');
    }
    const canonical = normalizeStoredTerminalPath(await this.#fileSystem.realpath(normalized));
    this.#assertOperation(token);
    assertLocalAbsolutePath(canonical, this.#platform);
    const canonicalMetadata = await this.#fileSystem.stat(canonical);
    this.#assertOperation(token);
    if (!canonicalMetadata.isDirectory()) {
      throw new Error('The terminal working directory is unavailable.');
    }
    return canonical;
  }

  async #requireExecutable(candidate: string, token: OperationToken): Promise<string> {
    try {
      return await this.#resolveExecutable(candidate, token);
    } catch {
      this.#assertOperation(token);
      throw new Error('The terminal executable is unavailable.');
    }
  }

  async #resolveExecutable(candidate: string, token: OperationToken): Promise<string> {
    const normalized = normalizeStoredTerminalPath(candidate);
    assertLocalAbsolutePath(normalized, this.#platform);
    const metadata = await this.#fileSystem.lstat(normalized);
    this.#assertOperation(token);
    if (metadata.isSymbolicLink() || !metadata.isFile()) {
      throw new Error('The terminal executable is unavailable.');
    }
    const canonical = normalizeStoredTerminalPath(await this.#fileSystem.realpath(normalized));
    this.#assertOperation(token);
    assertLocalAbsolutePath(canonical, this.#platform);
    const canonicalMetadata = await this.#fileSystem.stat(canonical);
    this.#assertOperation(token);
    if (!canonicalMetadata.isFile()) {
      throw new Error('The terminal executable is unavailable.');
    }
    await this.#fileSystem.access(canonical, constants.X_OK);
    this.#assertOperation(token);
    return canonical;
  }

  #captureOperation(): OperationToken {
    if (!this.#accepting) {
      throw new Error('Terminal configuration is shutting down.');
    }
    return { generation: this.#generation };
  }

  #assertOperation(token: OperationToken): void {
    if (!this.#accepting || token.generation !== this.#generation) {
      throw new Error('Terminal configuration is shutting down.');
    }
  }

  #withCapabilityOrder<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#capabilityQueue.then(operation, operation);
    this.#capabilityQueue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  async #assertPreferencesUnchanged(
    workspaceId: string,
    expected: StoredTerminalPreferences,
    token: OperationToken,
  ): Promise<void> {
    const current = await this.#store.getTerminalPreferences(workspaceId);
    this.#assertOperation(token);
    if (!samePreferences(current, expected)) {
      throw new Error('Terminal settings changed before the session could be created.');
    }
  }
}

function findProfile(
  profiles: readonly ResolvedTerminalProfile[],
  profileId: TerminalProfileId,
): ResolvedTerminalProfile {
  const profile = profiles.find(({ profile: candidate }) => candidate.id === profileId);
  if (!profile) throw new Error('The terminal profile is unavailable.');
  return profile;
}

function publicWslConfiguration(
  preferences: StoredTerminalPreferences,
  snapshot: WslDiscoverySnapshot,
): TerminalConfigurationSnapshot['wsl'] {
  const selected =
    preferences.wslDistributionName === null
      ? null
      : snapshot.distributions.find(({ name }) => name === preferences.wslDistributionName);
  const selectedId =
    preferences.wslDistributionName === null
      ? null
      : (selected?.id ??
        createWslDistributionId(snapshot.capabilityRevision, preferences.wslDistributionName));
  return Object.freeze({
    status: snapshot.status,
    capabilityRevision: snapshot.capabilityRevision,
    distributions: Object.freeze(
      snapshot.distributions.map(({ id, label }) => Object.freeze({ id, label })),
    ),
    selectedDistributionId: selectedId,
    selectedDistributionLabel:
      preferences.wslDistributionName === null
        ? null
        : (selected?.label ?? preferences.wslDistributionName),
    selectedDistributionAvailable:
      snapshot.status === 'ready' &&
      (preferences.wslDistributionName === null || selected !== undefined),
  });
}

function freezeState(state: TerminalConfigurationState): TerminalConfigurationState {
  return Object.freeze({
    profiles: Object.freeze(
      state.profiles.map(({ profile, executable, args }) =>
        Object.freeze({
          profile: Object.freeze({ ...profile }),
          ...(executable ? { executable } : {}),
          args: Object.freeze([...args]),
        }),
      ),
    ),
    configuration: Object.freeze({
      ...state.configuration,
      workingDirectory: Object.freeze({ ...state.configuration.workingDirectory }),
      wsl: Object.freeze({
        ...state.configuration.wsl,
        distributions: Object.freeze(
          state.configuration.wsl.distributions.map((distribution) =>
            Object.freeze({ ...distribution }),
          ),
        ),
      }),
    }),
  });
}

function freezeResolvedLaunch(
  state: TerminalConfigurationState,
  launch: TerminalLaunchConfiguration,
): ResolvedTerminalLaunch {
  return Object.freeze({
    state,
    launch: Object.freeze({
      ...launch,
      args: Object.freeze([...launch.args]),
    }),
  });
}

function requireHostPlatform(platform: NodeJS.Platform): TerminalHostPlatform {
  if (platform !== 'win32' && platform !== 'darwin' && platform !== 'linux') {
    throw new Error('Terminal working-directory selection is unsupported on this platform.');
  }
  return platform;
}

function assertLocalAbsolutePath(value: string, platform: NodeJS.Platform): void {
  if (platform === 'win32') {
    if (
      !win32.isAbsolute(value) ||
      !/^[a-z]:\\/iu.test(value) ||
      value.startsWith('\\\\') ||
      value.startsWith('//') ||
      /^\\\\[.?]\\?/u.test(value)
    ) {
      throw new Error('The terminal path must be a local absolute path.');
    }
    return;
  }
  if ((platform !== 'darwin' && platform !== 'linux') || !posix.isAbsolute(value)) {
    throw new Error('The terminal path must be a local absolute path.');
  }
}

function samePath(first: string, second: string, platform: NodeJS.Platform): boolean {
  return platform === 'win32'
    ? first.localeCompare(second, 'en-US', { sensitivity: 'accent' }) === 0
    : first === second;
}

function sameArguments(first: readonly string[], second: readonly string[]): boolean {
  return first.length === second.length && first.every((value, index) => value === second[index]);
}

function samePreferences(
  first: StoredTerminalPreferences,
  second: StoredTerminalPreferences,
): boolean {
  return (
    first.workspaceId === second.workspaceId &&
    first.preferredProfileId === second.preferredProfileId &&
    first.nativeCwdPlatform === second.nativeCwdPlatform &&
    first.nativeCwdPath === second.nativeCwdPath &&
    first.wslDistributionName === second.wslDistributionName &&
    first.revision === second.revision
  );
}
