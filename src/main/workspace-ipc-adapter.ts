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

export interface WorkspaceTerminalLifecycle {
  setActiveWorkspace(workspaceId: string): void;
  discardWorkspace(workspaceId: string): void;
}

export function createWorkspaceIpcAdapter(
  persistence: WorkspaceIpcPersistence,
  browser: WorkspaceBrowserLifecycle,
  terminal: WorkspaceTerminalLifecycle,
  onSnapshot: (snapshot: WorkspaceSnapshot) => void,
  onWorkspaceArchived: (workspaceId: string) => void = () => undefined,
) {
  const track = async (operation: Promise<WorkspaceSnapshot>): Promise<WorkspaceSnapshot> => {
    const snapshot = await operation;
    terminal.setActiveWorkspace(snapshot.currentWorkspaceId);
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
      terminal.setActiveWorkspace(snapshot.currentWorkspaceId);
      try {
        browser.discardWorkspace(input.workspaceId);
      } catch {
        // The database commit is authoritative; native cleanup cannot turn it into a false failure.
      }
      try {
        terminal.discardWorkspace(input.workspaceId);
      } catch {
        // The database commit is authoritative; native cleanup cannot turn it into a false failure.
      }
      try {
        onWorkspaceArchived(input.workspaceId);
      } catch {
        // Runtime cleanup cannot turn a committed workspace archive into a false failure.
      }
      onSnapshot(snapshot);
      return snapshot;
    },
    updateWorkspacePreferences: (input: WorkspacePreferencesInput) =>
      persistence.updateWorkspacePreferences(input),
  };
}
