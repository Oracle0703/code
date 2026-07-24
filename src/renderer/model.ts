import type { WorkspaceViewId } from '../shared/contracts';

export type { WorkspaceTheme as ThemeMode, WorkspaceViewId as ViewId } from '../shared/contracts';

/**
 * Renderer-only surfaces may sit alongside persisted workspace views without
 * changing the database-backed WorkspaceViewId contract.
 */
export type AppSurfaceId = WorkspaceViewId | 'assistant';
