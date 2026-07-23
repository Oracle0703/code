import type {
  WorkspaceCreateInput,
  WorkspacePreferences,
  WorkspacePreferencesInput,
  WorkspaceRenameInput,
  WorkspaceSnapshot,
  WorkspaceTargetInput,
} from '../shared/contracts';

export interface WorkspaceIpcPersistence {
  getWorkspaceSnapshot(): Promise<WorkspaceSnapshot>;
  createWorkspace(input: WorkspaceCreateInput): Promise<WorkspaceSnapshot>;
  renameWorkspace(input: WorkspaceRenameInput): Promise<WorkspaceSnapshot>;
  activateWorkspace(input: WorkspaceTargetInput): Promise<WorkspaceSnapshot>;
  archiveWorkspace(input: WorkspaceTargetInput): Promise<WorkspaceSnapshot>;
  updateWorkspacePreferences(input: WorkspacePreferencesInput): Promise<WorkspacePreferences>;
}

export interface WorkspaceBrowserLifecycle {
  discardWorkspace(workspaceId: string): void;
}

export function createWorkspaceIpcAdapter(
  persistence: WorkspaceIpcPersistence,
  browser: WorkspaceBrowserLifecycle,
  onSnapshot: (snapshot: WorkspaceSnapshot) => void,
) {
  const track = async (operation: Promise<WorkspaceSnapshot>): Promise<WorkspaceSnapshot> => {
    const snapshot = await operation;
    onSnapshot(snapshot);
    return snapshot;
  };

  return {
    getWorkspaceSnapshot: () => track(persistence.getWorkspaceSnapshot()),
    createWorkspace: (input: WorkspaceCreateInput) => track(persistence.createWorkspace(input)),
    renameWorkspace: (input: WorkspaceRenameInput) => track(persistence.renameWorkspace(input)),
    activateWorkspace: (input: WorkspaceTargetInput) => track(persistence.activateWorkspace(input)),
    archiveWorkspace: async (input: WorkspaceTargetInput) => {
      const snapshot = await persistence.archiveWorkspace(input);
      try {
        browser.discardWorkspace(input.workspaceId);
      } catch {
        // The database commit is authoritative; native cleanup cannot turn it into a false failure.
      }
      onSnapshot(snapshot);
      return snapshot;
    },
    updateWorkspacePreferences: (input: WorkspacePreferencesInput) =>
      persistence.updateWorkspacePreferences(input),
  };
}
