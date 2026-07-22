export type ViewId = 'today' | 'inbox' | 'tasks' | 'notes' | 'automations' | 'settings';

export interface Workspace {
  id: string;
  name: string;
  shortName: string;
  color: string;
}

export type ThemeMode = 'dark' | 'light';
