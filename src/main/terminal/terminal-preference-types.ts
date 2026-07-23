import type { TerminalProfileId } from '../../shared/contracts';
import type { TerminalHostPlatform } from '../../shared/terminal-domain';

export interface StoredTerminalPreferences {
  readonly workspaceId: string;
  readonly preferredProfileId: TerminalProfileId;
  readonly nativeCwdPlatform: TerminalHostPlatform | null;
  readonly nativeCwdPath: string | null;
  readonly wslDistributionName: string | null;
  readonly revision: number;
  readonly updatedAt: string;
}

export interface TerminalProfilePreferenceWrite {
  readonly workspaceId: string;
  readonly preferredProfileId: TerminalProfileId;
  readonly expectedRevision: number;
}

export interface TerminalWorkingDirectoryPreferenceWrite {
  readonly workspaceId: string;
  readonly nativeCwdPlatform: TerminalHostPlatform | null;
  readonly nativeCwdPath: string | null;
  readonly expectedRevision: number;
}

export interface TerminalWslDistributionPreferenceWrite {
  readonly workspaceId: string;
  readonly wslDistributionName: string | null;
  readonly expectedRevision: number;
}

export interface TerminalPreferenceStore {
  getTerminalPreferences(workspaceId: string): Promise<StoredTerminalPreferences>;
  updateTerminalProfilePreference(
    input: TerminalProfilePreferenceWrite,
  ): Promise<StoredTerminalPreferences>;
  updateTerminalWorkingDirectoryPreference(
    input: TerminalWorkingDirectoryPreferenceWrite,
  ): Promise<StoredTerminalPreferences>;
  updateTerminalWslDistributionPreference(
    input: TerminalWslDistributionPreferenceWrite,
  ): Promise<StoredTerminalPreferences>;
}
