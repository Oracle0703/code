import {
  useEffect,
  useCallback,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import {
  AppWindow,
  Archive,
  ArchiveRestore,
  Bot,
  CheckSquare2,
  Command,
  Download,
  FolderPlus,
  Globe2,
  Inbox,
  Layers3,
  LayoutDashboard,
  Minus,
  Moon,
  NotebookPen,
  PanelBottom,
  PanelLeftClose,
  PanelLeftOpen,
  PanelRight,
  Pencil,
  Plus,
  Search,
  Settings2,
  Sparkles,
  Square,
  SquareTerminal,
  Sun,
  Upload,
  X,
} from 'lucide-react';
import {
  DEFAULT_WORKSPACE_PREFERENCES,
  WORKSPACE_COLORS,
  type AssistantContextReference,
  type AutomationAction,
  type AutomationItem,
  type AutomationSchedule,
  type DatabaseBackupRestoreInput,
  type DatabaseBackupRestoreResult,
  type InboxEntry,
  type ScheduleItem,
  type ScheduleKind,
  type ScheduleSnapshot,
  type SearchResult,
  type TaskPlanning,
  type WorkspaceColor,
} from '../shared/contracts';
import {
  ASSISTANT_API_KEY_MAX_LENGTH,
  ASSISTANT_API_KEY_MIN_LENGTH,
  ASSISTANT_PROMPT_MAX_LENGTH,
  ASSISTANT_SELECTED_TASK_MAX_COUNT,
} from '../shared/assistant-domain';
import { isQuickCaptureShortcut } from '../shared/quick-capture-shortcut';
import { findCurrentWorkspace } from '../shared/workspace-domain';
import { ActivityRail } from './components/ActivityRail';
import { ArchivedWorkspacesDialog } from './components/ArchivedWorkspacesDialog';
import { AssistantPage } from './components/AssistantPage';
import { AutomationCreateSyncWarning } from './components/AutomationCreateSyncWarning';
import { AutomationCreateToast } from './components/AutomationCreateToast';
import { AutomationDialog, type AutomationDialogState } from './components/AutomationDialog';
import { AutomationPage } from './components/AutomationPage';
import { BackupCreateSyncWarning } from './components/BackupCreateSyncWarning';
import { BrowserPanel } from './components/BrowserPanel';
import { CommandPalette, type PaletteCommand } from './components/CommandPalette';
import { DataImportDialog } from './components/DataImportDialog';
import { FocusSessionDialog } from './components/FocusSessionDialog';
import { IconButton } from './components/IconButton';
import { InboxCaptureSyncWarning } from './components/InboxCaptureSyncWarning';
import { InboxCaptureToast } from './components/InboxCaptureToast';
import { InboxPage } from './components/InboxPage';
import { InboxUndoStack } from './components/InboxUndoStack';
import { NotePage } from './components/NotePage';
import { QuickCaptureDialog, type QuickCaptureTarget } from './components/QuickCaptureDialog';
import { ScheduleCreateSyncWarning } from './components/ScheduleCreateSyncWarning';
import { ScheduleCreateToast } from './components/ScheduleCreateToast';
import { ScheduleDialog, type ScheduleDialogState } from './components/ScheduleDialog';
import { ScheduleMutationSyncWarning } from './components/ScheduleMutationSyncWarning';
import { SettingsPage, type SettingsSection } from './components/SettingsPage';
import { TaskCreateSyncWarning } from './components/TaskCreateSyncWarning';
import { TaskCreateToast } from './components/TaskCreateToast';
import { TaskDialog, type TaskDialogState } from './components/TaskDialog';
import { TaskPage } from './components/TaskPage';
import { TerminalPanel } from './components/TerminalPanel';
import { TodayDashboard } from './components/TodayDashboard';
import { WorkspaceDialog, type WorkspaceDialogState } from './components/WorkspaceDialog';
import { WorkspaceSidebar } from './components/WorkspaceSidebar';
import { useInboxController } from './hooks/useInboxController';
import { useAssistantController } from './hooks/useAssistantController';
import { useAutomationController } from './hooks/useAutomationController';
import { useDataManagementController } from './hooks/useDataManagementController';
import { useFocusController } from './hooks/useFocusController';
import { useGlobalSearchController } from './hooks/useGlobalSearchController';
import {
  useNoteController,
  type NoteArchiveCommit,
  type NoteCreateCommit,
  type NoteMutationRecovery,
  type NoteUpdateCommit,
} from './hooks/useNoteController';
import {
  useScheduleController,
  type ScheduleArchiveCommit,
  type ScheduleMutationRecovery,
  type ScheduleUpdateCommit,
} from './hooks/useScheduleController';
import { useTaskController } from './hooks/useTaskController';
import { useWorkspaceController } from './hooks/useWorkspaceController';
import { openBrowserUrlInWorkspace } from './browser-state';
import {
  clearResolvedNoteCreateSyncWarning,
  convertedNoteFromSnapshot,
  createNoteWorkspaceIdentity,
  isNoteCreateNavigationBlocked,
  isNoteMutationNavigationBlocked,
  noteCreateSyncWarningForActivation,
  noteMutationSyncWarningForActivation,
  type NoteCreateSyncWarningState,
  type NoteCreateSyncWarningTarget,
  type NoteMutationSyncWarningState,
  type NoteMutationSyncWarningTarget,
  type NoteWorkspaceIdentity,
} from './note-state';
import {
  NoteMutationCoordinator,
  type NoteMutationCoordinatorIntent,
} from './note-mutation-coordinator';
import {
  AssistantSavedNoteNavigationCoordinator,
  AssistantSavedNoteSaveGate,
  AssistantSavedNoteSupersededError,
  assistantResponseKey,
  assistantSavedNoteNavigationError,
  createAssistantWorkspaceIdentity,
  resolveAssistantSavedNoteNavigationTarget,
  type AssistantSavedNoteTarget,
  type AssistantWorkspaceIdentity,
} from './assistant-saved-note-navigation';
import {
  AutomationOutputNavigationCoordinator,
  automationOutputNavigationError,
  resolveAutomationOutputNavigationTarget,
} from './automation-output-navigation';
import {
  AutomationCreateCoordinator,
  AutomationCreateNoteDraftPreservedError,
  AutomationCreateSupersededError,
  AutomationCreateSyncRefreshError,
  automationCreateNavigationError,
  automationCreateSyncRefreshError,
  createAutomationCreateWorkspaceIdentity,
  resolveAutomationCreateNavigationTarget,
  type AutomationCreateFeedback,
  type AutomationCreateWorkspaceIdentity,
} from './automation-create-navigation';
import {
  createInboxCaptureWorkspaceIdentity,
  InboxCaptureCoordinator,
  InboxCapturePublicationGate,
  InboxCaptureSupersededError,
  inboxCaptureNavigationError,
  inboxCaptureSyncRefreshError,
  resolveInboxCaptureNavigationTarget,
  resolveInboxCaptureSyncRefreshEntry,
  type InboxCaptureFeedback,
  type InboxCaptureWorkspaceIdentity,
} from './inbox-capture-navigation';
import {
  createInboxConversionWorkspaceIdentity,
  InboxConversionNavigationCoordinator,
  InboxConversionPublicationGate,
  InboxConversionRequestCoordinator,
  InboxConversionSupersededError,
  inboxConversionNavigationError,
  reconcileInboxConversionSnapshots,
  resolveInboxConversionNavigationTarget,
  type InboxConversionFeedback,
  type InboxConversionRequestIntent,
  type InboxConversionWorkspaceIdentity,
} from './inbox-conversion-navigation';
import { isInboxConversionSourceArchived } from './inbox-state';
import {
  createAutomationWorkspaceIdentity,
  automationRunFeedbackKey,
  type AutomationRunActivity,
  type AutomationRunFeedback,
  type AutomationWorkspaceIdentity,
} from './automation-state';
import {
  AutomationRunReconciliationCoordinator,
  reconcileAutomationRunOutput,
  type AutomationRunReconciliationIntent,
} from './automation-run-reconciliation';
import type { AppSurfaceId } from './model';
import {
  createScheduleCreateWorkspaceIdentity,
  isScheduleCreateTodayDateCurrent,
  resolveScheduleCreateNavigationTarget,
  ScheduleCreateCoordinator,
  ScheduleCreateNoteDraftPreservedError,
  ScheduleCreatePublicationGate,
  ScheduleCreateSupersededError,
  ScheduleCreateSyncRefreshError,
  ScheduleCreateUnavailableError,
  scheduleCreateNavigationError,
  scheduleCreateSyncRefreshError,
  type ScheduleCreateFeedback,
  type ScheduleCreateWorkspaceIdentity,
} from './schedule-create-navigation';
import {
  createScheduleWorkspaceIdentity,
  defaultScheduleRangeForPlanningDate,
  type ScheduleArchiveMutationIntent,
  type ScheduleUpdateMutationIntent,
  type ScheduleWorkspaceIdentity,
} from './schedule-state';
import {
  ScheduleMutationCoordinator,
  type ScheduleMutationCoordinatorIntent,
} from './schedule-mutation-coordinator';
import {
  SearchNavigationCoordinator,
  assertSearchTargetExists,
  searchNavigationError,
} from './search-navigation';
import { EMPTY_ASSISTANT_CONTEXT, assistantEntryContextForWorkspace } from './assistant-state';
import {
  createFocusWorkspaceIdentity,
  focusStartUnavailableReason,
  focusTaskOptionsUnavailableReason,
  isFocusDialogActivationCurrent,
  isTaskEligibleForFocus,
  taskFocusStartUnavailableReason,
  type FocusWorkspaceIdentity,
} from './focus-state';
import {
  FocusTaskCompletionCoordinator,
  FocusTaskCompletionGate,
  FocusTaskCompletionSupersededError,
  focusTaskCompletionError,
  focusTaskCompletionFailed,
  focusTaskCompletionFinished,
  focusTaskCompletionStarted,
  resolveFocusTaskCompletionTarget,
  selectFocusTaskCompletionNotice,
  type FocusTaskCompletionActionState,
  type FocusTaskCompletionNotice,
} from './focus-task-completion';
import {
  createTaskCreateWorkspaceIdentity,
  resolveTaskCreateNavigationTarget,
  TaskCreateCoordinator,
  TaskCreateNoteDraftPreservedError,
  TaskCreateSupersededError,
  taskCreateNavigationError,
  type TaskCreateFeedback,
  type TaskCreateWorkspaceIdentity,
} from './task-create-navigation';
import { convertedTaskFromSnapshot } from './task-state';
import {
  dataReplacementCloseApproved,
  evaluateWindowCloseProtection,
  shouldProtectWindowUnload,
  synchronizeDirtyDraft,
} from './window-close';

const viewLabels: Record<AppSurfaceId, string> = {
  today: '今日',
  inbox: '收件箱',
  tasks: '任务',
  notes: '笔记',
  automations: '自动化',
  assistant: 'AI 助手',
  settings: '设置',
};
const ASSISTANT_SAVED_NOTE_TARGET_LIMIT = 24;

function clamp(value: number, minimum: number, maximum: number) {
  return Math.min(Math.max(value, minimum), maximum);
}

function isEditableTarget(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLElement &&
    (target.matches('input, textarea, select') || target.isContentEditable)
  );
}

function isTerminalTarget(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest('.xterm') !== null;
}

interface FocusDialogState {
  readonly id: number;
  readonly activation: FocusWorkspaceIdentity;
  readonly initialTask: {
    readonly id: string;
    readonly title: string;
  } | null;
}

interface AutomationCreateSyncWarningState {
  readonly activation: AutomationCreateWorkspaceIdentity;
  readonly requestGeneration: number;
  readonly createdAutomationId: string;
  readonly name: string;
  readonly enabled: boolean;
  readonly message: string;
}

interface ScheduleCreateSyncWarningState {
  readonly activation: ScheduleCreateWorkspaceIdentity;
  readonly requestGeneration: number;
  readonly createdScheduleId: string;
  readonly title: string;
  readonly scheduledFor: string;
  readonly startMinute: number;
  readonly endMinute: number;
  readonly message: string;
}

interface InboxCaptureSyncWarningState {
  readonly activation: InboxCaptureWorkspaceIdentity;
  readonly requestGeneration: number;
  readonly createdEntryId: string;
  readonly content: string;
  readonly focusActionOnMount: boolean;
  readonly message: string;
}

interface InboxConversionSyncWarningState {
  readonly activation: InboxConversionWorkspaceIdentity;
  readonly feedback: InboxConversionFeedback;
  readonly focusActionOnMount: boolean;
  readonly message: string;
}

type InboxCapturePublication =
  | {
      readonly kind: 'feedback';
      readonly activation: InboxCaptureWorkspaceIdentity;
      readonly feedback: InboxCaptureFeedback;
    }
  | {
      readonly kind: 'warning';
      readonly warning: InboxCaptureSyncWarningState;
    };

type InboxConversionPublication =
  | {
      readonly kind: 'feedback';
      readonly activation: InboxConversionWorkspaceIdentity;
      readonly feedback: InboxConversionFeedback;
    }
  | {
      readonly kind: 'warning';
      readonly warning: InboxConversionSyncWarningState;
    };

type ScheduleCreatePublication =
  | {
      readonly kind: 'feedback';
      readonly activation: ScheduleCreateWorkspaceIdentity;
      readonly feedback: ScheduleCreateFeedback;
      readonly todayDate: string;
    }
  | {
      readonly kind: 'warning';
      readonly warning: ScheduleCreateSyncWarningState;
    };

type AutomationRunPublication =
  | {
      readonly kind: 'feedback';
      readonly feedback: AutomationRunFeedback;
    }
  | {
      readonly kind: 'warning';
      readonly feedback: AutomationRunFeedback;
      readonly focusActionOnMount: boolean;
      readonly refreshing: boolean;
      readonly refreshError: string | null;
    };

type NoteMutationSyncWarningPublication = NoteMutationSyncWarningState & {
  readonly focusActionOnMount: boolean;
  readonly refreshing: boolean;
  readonly refreshError: string | null;
};

type ScheduleMutationSyncWarningTarget =
  | {
      readonly kind: 'update';
      readonly intent: ScheduleUpdateMutationIntent;
      readonly resultSnapshot: ScheduleSnapshot;
      readonly message: string;
    }
  | {
      readonly kind: 'archive';
      readonly intent: ScheduleArchiveMutationIntent;
      readonly resultSnapshot: ScheduleSnapshot;
      readonly message: string;
    };

type ScheduleMutationSyncWarningPublication = ScheduleMutationSyncWarningTarget & {
  readonly activation: ScheduleWorkspaceIdentity;
  readonly focusActionOnMount: boolean;
  readonly refreshing: boolean;
  readonly refreshError: string | null;
};

function noteUpdateSyncWarning(commit: NoteUpdateCommit): NoteMutationSyncWarningTarget {
  return {
    kind: 'update',
    intent: commit.intent,
    resultSnapshot: commit.result,
    title: commit.intent.title,
    message:
      commit.reconciliationWarning ??
      '笔记已保存，但当前笔记列表未能同步。请重新读取后查看，避免重复保存。',
  };
}

function noteArchiveSyncWarning(commit: NoteArchiveCommit): NoteMutationSyncWarningTarget {
  return {
    kind: 'archive',
    intent: commit.intent,
    resultSnapshot: commit.result,
    title: commit.intent.originalNote.title,
    message:
      commit.reconciliationWarning ??
      '笔记已归档，但当前笔记列表未能同步。请重新读取后确认，避免重复归档。',
  };
}

function scheduleUpdateSyncWarning(
  commit: ScheduleUpdateCommit,
): ScheduleMutationSyncWarningTarget {
  return {
    kind: 'update',
    intent: commit.intent,
    resultSnapshot: commit.result,
    message:
      commit.reconciliationWarning ??
      '日程已保存，但当前计划未能同步。请重新读取后查看，避免重复保存。',
  };
}

function scheduleArchiveSyncWarning(
  commit: ScheduleArchiveCommit,
): ScheduleMutationSyncWarningTarget {
  return {
    kind: 'archive',
    intent: commit.intent,
    resultSnapshot: commit.result,
    message:
      commit.reconciliationWarning ??
      '日程已归档，但当前计划未能同步。请重新读取后确认，避免重复归档。',
  };
}

function focusAutomationActivityRailAnchor(): void {
  document
    .querySelector<HTMLButtonElement>('.activity-rail button[aria-label="自动化"]')
    ?.focus({ preventScroll: true });
}

function focusTodayActivityRailAnchor(): void {
  document
    .querySelector<HTMLButtonElement>('.activity-rail button[aria-label="今日"]')
    ?.focus({ preventScroll: true });
}

export function App() {
  const workspaceController = useWorkspaceController();
  const {
    state: dataState,
    manualBackupSyncWarning,
    manualBackupBlocked,
    load: loadData,
    createBackup,
    refreshManualBackupSyncWarning,
    invalidateManualBackupRecovery,
    restoreBackup,
    updateBackupPolicy,
    exportData,
    chooseImport,
    commitImport,
    cancelImport,
    currentImportPreview,
    isImportCommitInFlight,
  } = useDataManagementController();
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [workspaceDialog, setWorkspaceDialog] = useState<WorkspaceDialogState | null>(null);
  const [quickCaptureTarget, setQuickCaptureTarget] = useState<QuickCaptureTarget | null>(null);
  const [taskDialog, setTaskDialog] = useState<TaskDialogState | null>(null);
  const [scheduleDialog, setScheduleDialog] = useState<ScheduleDialogState | null>(null);
  const [automationDialog, setAutomationDialog] = useState<AutomationDialogState | null>(null);
  const [focusDialog, setFocusDialog] = useState<FocusDialogState | null>(null);
  const [focusSuccessSequence, setFocusSuccessSequence] = useState(0);
  const [dismissedFocusTaskCompletions, setDismissedFocusTaskCompletions] = useState<
    ReadonlySet<string>
  >(() => new Set());
  const [focusTaskCompletionAction, setFocusTaskCompletionAction] =
    useState<FocusTaskCompletionActionState | null>(null);
  const [noteDraftDirty, setNoteDraftDirty] = useState(false);
  const [noteCreateSyncWarningState, setNoteCreateSyncWarningState] =
    useState<NoteCreateSyncWarningState | null>(null);
  const [noteMutationSyncWarningState, setNoteMutationSyncWarningState] =
    useState<NoteMutationSyncWarningPublication | null>(null);
  const [settingsSection, setSettingsSection] = useState<SettingsSection>('general');
  const [assistantSurfaceOpen, setAssistantSurfaceOpen] = useState(false);
  const [assistantEntry, setAssistantEntry] = useState<{
    readonly workspaceId: string | null;
    readonly context: AssistantContextReference;
    readonly generation: number;
  }>({ workspaceId: null, context: EMPTY_ASSISTANT_CONTEXT, generation: 0 });
  const [assistantSavedNotes, setAssistantSavedNotes] = useState<
    ReadonlyMap<string, AssistantSavedNoteTarget>
  >(() => new Map());
  const [requestedNoteId, setRequestedNoteId] = useState<string | null>(null);
  const [notePageGeneration, setNotePageGeneration] = useState(0);
  const [inboxReveal, setInboxReveal] = useState<{
    readonly workspaceId: string;
    readonly entryId: string;
    readonly generation: number;
    readonly handled: boolean;
  } | null>(null);
  const [inboxCaptureFeedbackState, setInboxCaptureFeedbackState] = useState<{
    readonly activation: InboxCaptureWorkspaceIdentity;
    readonly feedback: InboxCaptureFeedback;
  } | null>(null);
  const [inboxCaptureSyncWarningState, setInboxCaptureSyncWarningState] =
    useState<InboxCaptureSyncWarningState | null>(null);
  const [taskCreateFeedbackState, setTaskCreateFeedbackState] = useState<{
    readonly activation: TaskCreateWorkspaceIdentity;
    readonly feedback: TaskCreateFeedback;
  } | null>(null);
  const [taskCreateSyncWarningState, setTaskCreateSyncWarningState] = useState<{
    readonly activation: TaskCreateWorkspaceIdentity;
    readonly requestGeneration: number;
    readonly title: string;
    readonly message: string;
  } | null>(null);
  const [scheduleCreateFeedbackState, setScheduleCreateFeedbackState] = useState<{
    readonly activation: ScheduleCreateWorkspaceIdentity;
    readonly feedback: ScheduleCreateFeedback;
  } | null>(null);
  const [scheduleCreateSyncWarningState, setScheduleCreateSyncWarningState] =
    useState<ScheduleCreateSyncWarningState | null>(null);
  const [scheduleMutationSyncWarningState, setScheduleMutationSyncWarningState] =
    useState<ScheduleMutationSyncWarningPublication | null>(null);
  const [scheduleNavigationPending, setScheduleNavigationPending] = useState(false);
  const [automationCreateFeedbackState, setAutomationCreateFeedbackState] = useState<{
    readonly activation: AutomationCreateWorkspaceIdentity;
    readonly feedback: AutomationCreateFeedback;
  } | null>(null);
  const [automationCreateSyncWarningState, setAutomationCreateSyncWarningState] =
    useState<AutomationCreateSyncWarningState | null>(null);
  const [automationRunPublications, setAutomationRunPublications] = useState<
    ReadonlyMap<string, AutomationRunPublication>
  >(() => new Map());
  const [automationRunActivities, setAutomationRunActivities] = useState<
    ReadonlyMap<string, AutomationRunActivity>
  >(() => new Map());
  const [inboxConversionFeedbackState, setInboxConversionFeedbackState] = useState<{
    readonly activation: InboxConversionWorkspaceIdentity;
    readonly feedback: InboxConversionFeedback;
  } | null>(null);
  const [inboxConversionSyncWarningState, setInboxConversionSyncWarningState] =
    useState<InboxConversionSyncWarningState | null>(null);
  const [pendingInboxConversionIntents, setPendingInboxConversionIntents] = useState<
    ReadonlyMap<string, InboxConversionRequestIntent>
  >(() => new Map());
  const [focusedInboxConversionFeedbackKey, setFocusedInboxConversionFeedbackKey] = useState<
    string | null
  >(null);
  const [searchNavigation] = useState(() => new SearchNavigationCoordinator());
  const [automationOutputNavigation] = useState(() => new AutomationOutputNavigationCoordinator());
  const [inboxCaptureCoordinator] = useState(() => new InboxCaptureCoordinator());
  const [inboxCapturePublicationGate] = useState(
    () => new InboxCapturePublicationGate<InboxCapturePublication>(),
  );
  const [taskCreateCoordinator] = useState(() => new TaskCreateCoordinator());
  const [scheduleCreateCoordinator] = useState(() => new ScheduleCreateCoordinator());
  const [scheduleCreatePublicationGate] = useState(
    () => new ScheduleCreatePublicationGate<ScheduleCreatePublication>(),
  );
  const [automationCreateCoordinator] = useState(() => new AutomationCreateCoordinator());
  const [automationRunReconciliationCoordinator] = useState(
    () => new AutomationRunReconciliationCoordinator(),
  );
  const [inboxConversionRequestCoordinator] = useState(
    () => new InboxConversionRequestCoordinator(),
  );
  const [inboxConversionPublicationGate] = useState(
    () => new InboxConversionPublicationGate<InboxConversionPublication>(),
  );
  const [inboxConversionNavigation] = useState(() => new InboxConversionNavigationCoordinator());
  const [assistantSavedNoteNavigation] = useState(
    () => new AssistantSavedNoteNavigationCoordinator(),
  );
  const [assistantSavedNoteSaveGate] = useState(() => new AssistantSavedNoteSaveGate());
  const [noteMutationCoordinator] = useState(() => new NoteMutationCoordinator());
  const [scheduleMutationCoordinator] = useState(() => new ScheduleMutationCoordinator());
  const [focusTaskCompletionCoordinator] = useState(() => new FocusTaskCompletionCoordinator());
  const [focusTaskCompletionGate] = useState(() => new FocusTaskCompletionGate());
  const [maximized, setMaximized] = useState(false);
  const [appVersion, setAppVersion] = useState('0.1.0');
  const [viewportHeight, setViewportHeight] = useState(() => window.innerHeight);
  const activeResizeFinishRef = useRef<(() => void) | null>(null);
  const focusDialogSequenceRef = useRef(0);
  const currentWorkspaceIdRef = useRef<string | null>(null);
  const currentSurfaceRef = useRef<AppSurfaceId>('today');
  const assistantSavedNotesRef = useRef<ReadonlyMap<string, AssistantSavedNoteTarget>>(new Map());
  const assistantSavedNoteActivationRef = useRef<AssistantWorkspaceIdentity>(
    createAssistantWorkspaceIdentity(null),
  );
  const assistantResponseKeyRef = useRef<string | null>(null);
  const assistantSavedNoteTargetRef = useRef<AssistantSavedNoteTarget | null>(null);
  const automationOutputActivationRef = useRef<AutomationWorkspaceIdentity>(
    createAutomationWorkspaceIdentity(null),
  );
  const automationRunFeedbackRef = useRef<AutomationRunFeedback | null>(null);
  const automationRunPublicationsRef = useRef<ReadonlyMap<string, AutomationRunPublication>>(
    new Map(),
  );
  const automationRunActivitiesRef = useRef<ReadonlyMap<string, AutomationRunActivity>>(new Map());
  const inboxCaptureActivationRef = useRef<InboxCaptureWorkspaceIdentity>(
    createInboxCaptureWorkspaceIdentity(null),
  );
  const inboxCaptureFeedbackRef = useRef<InboxCaptureFeedback | null>(null);
  const inboxCaptureSurfaceRef = useRef<AppSurfaceId>('today');
  const inboxCaptureSurfaceGenerationRef = useRef(0);
  const taskCreateActivationRef = useRef<TaskCreateWorkspaceIdentity>(
    createTaskCreateWorkspaceIdentity(null),
  );
  const taskCreateFeedbackRef = useRef<TaskCreateFeedback | null>(null);
  const taskCreateSurfaceRef = useRef<AppSurfaceId>('today');
  const scheduleCreateActivationRef = useRef<ScheduleCreateWorkspaceIdentity>(
    createScheduleCreateWorkspaceIdentity(null),
  );
  const scheduleCreateFeedbackRef = useRef<ScheduleCreateFeedback | null>(null);
  const scheduleCreateSurfaceRef = useRef<AppSurfaceId>('today');
  const scheduleMutationActivationRef = useRef<ScheduleWorkspaceIdentity>(
    createScheduleWorkspaceIdentity(null),
  );
  const scheduleMutationSyncWarningRef = useRef<ScheduleMutationSyncWarningPublication | null>(
    null,
  );
  const scheduleNavigationIntentRef = useRef<ScheduleMutationCoordinatorIntent | null>(null);
  const automationCreateActivationRef = useRef<AutomationCreateWorkspaceIdentity>(
    createAutomationCreateWorkspaceIdentity(null),
  );
  const automationCreateFeedbackRef = useRef<AutomationCreateFeedback | null>(null);
  const automationCreateSurfaceRef = useRef<AppSurfaceId>('today');
  const inboxConversionActivationRef = useRef<InboxConversionWorkspaceIdentity>(
    createInboxConversionWorkspaceIdentity(null),
  );
  const inboxConversionFeedbackRef = useRef<InboxConversionFeedback | null>(null);
  const inboxConversionSyncWarningRef = useRef<InboxConversionSyncWarningState | null>(null);
  const inboxConversionSurfaceRef = useRef<AppSurfaceId>('today');
  const focusTaskCompletionActivationRef = useRef<FocusWorkspaceIdentity>(
    createFocusWorkspaceIdentity(null),
  );
  const focusTaskCompletionNoticeRef = useRef<FocusTaskCompletionNotice | null>(null);
  const focusTaskCompletionSurfaceRef = useRef<AppSurfaceId>('today');
  const noteDraftDirtyRef = useRef(false);
  const noteCreateActivationRef = useRef(createNoteWorkspaceIdentity(null));
  const noteCreateSyncWarningRef = useRef<NoteCreateSyncWarningState | null>(null);
  const noteMutationSyncWarningRef = useRef<NoteMutationSyncWarningPublication | null>(null);
  const dataReplacementApprovedRef = useRef(false);
  const dataReplacementNoteDiscardApprovedRef = useRef(false);
  const snapshot = workspaceController.snapshot;
  const archiveManager = workspaceController.archiveManager;
  const focusActivation = useMemo(
    () => createFocusWorkspaceIdentity(snapshot?.currentWorkspaceId ?? null),
    [snapshot?.currentWorkspaceId],
  );
  const automationOutputActivation = useMemo(
    () => createAutomationWorkspaceIdentity(snapshot?.currentWorkspaceId ?? null),
    [snapshot?.currentWorkspaceId],
  );
  const assistantSavedNoteActivation = useMemo(
    () => createAssistantWorkspaceIdentity(snapshot?.currentWorkspaceId ?? null),
    [snapshot?.currentWorkspaceId],
  );
  const noteCreateActivation = useMemo(
    () => ({
      ...createNoteWorkspaceIdentity(snapshot?.currentWorkspaceId ?? null),
      pageGeneration: notePageGeneration,
    }),
    [notePageGeneration, snapshot?.currentWorkspaceId],
  );
  const inboxCaptureActivation = useMemo(
    () => createInboxCaptureWorkspaceIdentity(snapshot?.currentWorkspaceId ?? null),
    [snapshot?.currentWorkspaceId],
  );
  const taskCreateActivation = useMemo(
    () => createTaskCreateWorkspaceIdentity(snapshot?.currentWorkspaceId ?? null),
    [snapshot?.currentWorkspaceId],
  );
  const scheduleCreateActivation = useMemo(
    () => createScheduleCreateWorkspaceIdentity(snapshot?.currentWorkspaceId ?? null),
    [snapshot?.currentWorkspaceId],
  );
  const automationCreateActivation = useMemo(
    () => createAutomationCreateWorkspaceIdentity(snapshot?.currentWorkspaceId ?? null),
    [snapshot?.currentWorkspaceId],
  );
  useLayoutEffect(() => {
    noteCreateActivationRef.current = noteCreateActivation;
  }, [noteCreateActivation]);
  useEffect(() => {
    currentWorkspaceIdRef.current = snapshot?.currentWorkspaceId ?? null;
  }, [snapshot?.currentWorkspaceId]);
  useEffect(() => {
    const workspaceId = snapshot?.currentWorkspaceId;
    if (!workspaceId) return;
    queueMicrotask(() => {
      if (currentWorkspaceIdRef.current !== workspaceId) return;
      setAssistantEntry((current) => ({
        workspaceId,
        context: EMPTY_ASSISTANT_CONTEXT,
        generation: current.generation + 1,
      }));
    });
  }, [snapshot?.currentWorkspaceId]);
  const inboxController = useInboxController(snapshot?.currentWorkspaceId ?? null);
  const createInbox = inboxController.create;
  const prepareInboxSnapshotRefresh = inboxController.prepareSnapshotRefresh;
  const visibleInboxCaptureFeedback =
    inboxCaptureFeedbackState?.activation === inboxCaptureActivation
      ? inboxCaptureFeedbackState.feedback
      : null;
  const visibleInboxCaptureSyncWarning =
    inboxCaptureSyncWarningState?.activation === inboxCaptureActivation
      ? inboxCaptureSyncWarningState
      : null;
  const visibleTaskCreateFeedback =
    taskCreateFeedbackState?.activation === taskCreateActivation
      ? taskCreateFeedbackState.feedback
      : null;
  const visibleTaskCreateSyncWarning =
    taskCreateSyncWarningState?.activation === taskCreateActivation
      ? taskCreateSyncWarningState
      : null;
  const visibleScheduleCreateFeedback =
    scheduleCreateFeedbackState?.activation === scheduleCreateActivation
      ? scheduleCreateFeedbackState.feedback
      : null;
  const visibleScheduleCreateSyncWarning =
    scheduleCreateSyncWarningState?.activation === scheduleCreateActivation
      ? scheduleCreateSyncWarningState
      : null;
  const visibleAutomationCreateFeedback =
    automationCreateFeedbackState?.activation === automationCreateActivation
      ? automationCreateFeedbackState.feedback
      : null;
  const visibleAutomationCreateSyncWarning =
    automationCreateSyncWarningState?.activation === automationCreateActivation
      ? automationCreateSyncWarningState
      : null;
  const visibleInboxConversionFeedback =
    inboxConversionFeedbackState?.activation === inboxController.activation
      ? inboxConversionFeedbackState.feedback
      : null;
  const visibleInboxConversionSyncWarning =
    inboxConversionSyncWarningState?.activation === inboxController.activation
      ? inboxConversionSyncWarningState
      : null;
  const visibleNoteCreateSyncWarning = noteCreateSyncWarningForActivation(
    noteCreateActivation,
    noteCreateSyncWarningState,
  );
  const visibleNoteMutationSyncWarningTarget = noteMutationSyncWarningForActivation(
    noteCreateActivation,
    noteMutationSyncWarningState,
  );
  const visibleNoteMutationSyncWarning =
    visibleNoteMutationSyncWarningTarget === noteMutationSyncWarningState
      ? noteMutationSyncWarningState
      : null;
  const taskController = useTaskController(snapshot?.currentWorkspaceId ?? null);
  const noteController = useNoteController(snapshot?.currentWorkspaceId ?? null);
  const getCommittedTaskSnapshot = taskController.getCommittedSnapshot;
  const getCommittedNoteSnapshot = noteController.getCommittedSnapshot;
  const prepareTaskSnapshotRefresh = taskController.prepareSnapshotRefresh;
  const prepareNoteSnapshotRefresh = noteController.prepareSnapshotRefresh;
  const scheduleController = useScheduleController(snapshot?.currentWorkspaceId ?? null);
  const visibleScheduleMutationSyncWarning =
    scheduleMutationSyncWarningState?.activation === scheduleController.activation
      ? scheduleMutationSyncWarningState
      : null;
  const focusController = useFocusController(snapshot?.currentWorkspaceId ?? null);
  const focusTaskCompletion = useMemo(
    () =>
      selectFocusTaskCompletionNotice(
        focusActivation,
        focusController.snapshot,
        dismissedFocusTaskCompletions,
      ),
    [dismissedFocusTaskCompletions, focusActivation, focusController.snapshot],
  );
  const automationController = useAutomationController(snapshot?.currentWorkspaceId ?? null, {
    onRunOutput: ({ workspaceId, outputKind }) => {
      if (currentWorkspaceIdRef.current !== workspaceId) return;
      if (outputKind === 'task') {
        void taskController.refresh().catch(() => undefined);
      } else {
        void noteController.refresh().catch(() => undefined);
      }
    },
  });
  const currentAutomationRunPublication =
    snapshot?.currentWorkspaceId === undefined
      ? null
      : (automationRunPublications.get(snapshot.currentWorkspaceId) ?? null);
  const visibleAutomationRunFeedback =
    currentAutomationRunPublication?.kind === 'feedback'
      ? currentAutomationRunPublication.feedback
      : null;
  const visibleAutomationRunSyncWarning =
    currentAutomationRunPublication?.kind === 'warning'
      ? currentAutomationRunPublication.feedback
      : null;
  const visibleAutomationRunSyncWarningRefreshing =
    currentAutomationRunPublication?.kind === 'warning'
      ? currentAutomationRunPublication.refreshing
      : false;
  const visibleAutomationRunSyncWarningError =
    currentAutomationRunPublication?.kind === 'warning'
      ? currentAutomationRunPublication.refreshError
      : null;
  const visibleAutomationRunActivity =
    snapshot?.currentWorkspaceId === undefined
      ? null
      : (automationRunActivities.get(snapshot.currentWorkspaceId) ?? null);
  const externalNoteMutationBlockMessage =
    visibleInboxConversionSyncWarning?.feedback.outputKind === 'note'
      ? '请返回收件箱重新读取已转换笔记'
      : visibleAutomationRunSyncWarning?.outputKind === 'note'
        ? '请返回自动化重新读取运行输出'
        : null;
  const automationRunBlocked =
    snapshot?.currentWorkspaceId !== undefined &&
    (visibleAutomationRunActivity !== null || visibleAutomationRunSyncWarning !== null);
  const setAutomationRunPublication = useCallback(
    (workspaceId: string, publication: AutomationRunPublication | null): void => {
      const next = new Map(automationRunPublicationsRef.current);
      if (publication === null) {
        next.delete(workspaceId);
      } else {
        next.set(workspaceId, publication);
      }
      automationRunPublicationsRef.current = next;
      setAutomationRunPublications(next);
    },
    [],
  );
  const setAutomationRunActivity = useCallback(
    (workspaceId: string, activity: AutomationRunActivity | null): void => {
      const next = new Map(automationRunActivitiesRef.current);
      if (activity === null) {
        next.delete(workspaceId);
      } else {
        next.set(workspaceId, activity);
      }
      automationRunActivitiesRef.current = next;
      setAutomationRunActivities(next);
    },
    [],
  );
  const finishAutomationRunIntent = useCallback(
    (intent: AutomationRunReconciliationIntent): void => {
      automationRunReconciliationCoordinator.end(intent);
      if (automationRunReconciliationCoordinator.isPending(intent.workspaceId)) return;
      setAutomationRunActivity(intent.workspaceId, null);
    },
    [automationRunReconciliationCoordinator, setAutomationRunActivity],
  );
  const invalidateAutomationRuns = useCallback((): void => {
    automationRunReconciliationCoordinator.invalidateAll();
    automationRunPublicationsRef.current = new Map();
    automationRunActivitiesRef.current = new Map();
    setAutomationRunPublications(new Map());
    setAutomationRunActivities(new Map());
  }, [automationRunReconciliationCoordinator]);
  const assistantController = useAssistantController(snapshot?.currentWorkspaceId ?? null);
  const startAssistant = assistantController.start;
  const currentAssistantResponseKey = assistantResponseKey(assistantController.snapshot);
  const currentAssistantSavedNote =
    currentAssistantResponseKey === null
      ? null
      : (assistantSavedNotes.get(currentAssistantResponseKey) ?? null);
  const searchController = useGlobalSearchController({
    open: paletteOpen,
    workspaceId: snapshot?.currentWorkspaceId ?? null,
  });
  const activeWorkspace = snapshot ? findCurrentWorkspace(snapshot) : null;
  const focusStartBlockReason = focusStartUnavailableReason(
    snapshot?.currentWorkspaceId ?? null,
    focusController.snapshot,
    focusController.status,
    focusController.operation,
  );
  const taskFocusStartBlockReason = taskFocusStartUnavailableReason(
    snapshot?.currentWorkspaceId ?? null,
    taskController.snapshot,
    focusController.snapshot,
    taskController.status,
    focusController.status,
    focusController.operation,
  );
  const focusTaskOptionsBlockReason = focusTaskOptionsUnavailableReason(
    snapshot?.currentWorkspaceId ?? null,
    taskController.snapshot,
    focusController.snapshot,
    taskController.status,
  );
  const focusDialogTasks = useMemo(() => {
    const taskSnapshot = taskController.snapshot;
    const focusSnapshot = focusController.snapshot;
    if (
      taskController.status !== 'ready' ||
      taskSnapshot === null ||
      focusSnapshot === null ||
      taskSnapshot.workspaceId !== focusSnapshot.workspaceId ||
      taskSnapshot.todayDate !== focusSnapshot.todayDate
    ) {
      return [];
    }
    return taskSnapshot.tasks.filter((task) => isTaskEligibleForFocus(task, taskSnapshot));
  }, [focusController.snapshot, taskController.snapshot, taskController.status]);
  const assistantInitialContext = assistantEntryContextForWorkspace(
    snapshot?.currentWorkspaceId ?? null,
    assistantEntry.workspaceId,
    assistantEntry.context,
  );
  const visibleUndoNotices = useMemo(
    () =>
      activeWorkspace
        ? inboxController.undoNotices.filter(
            ({ workspaceId }) => workspaceId === activeWorkspace.id,
          )
        : [],
    [activeWorkspace, inboxController.undoNotices],
  );
  const preferences = snapshot?.preferences ?? DEFAULT_WORKSPACE_PREFERENCES;
  const {
    activeView,
    browserOpen,
    browserWidth,
    sidebarCollapsed,
    terminalHeight,
    terminalOpen,
    theme,
  } = preferences;
  const activeSurface: AppSurfaceId = assistantSurfaceOpen ? 'assistant' : activeView;
  const statusbarErrorSource = workspaceController.operationError
    ? 'workspace'
    : inboxController.operationError
      ? 'inbox'
      : taskController.operationError
        ? 'task'
        : noteController.operationError
          ? 'note'
          : scheduleController.operationError
            ? 'schedule'
            : automationController.operationError
              ? 'automation'
              : assistantController.credentialError || assistantController.runtimeError
                ? 'assistant'
                : dataState.feedback?.tone === 'error'
                  ? 'data'
                  : null;
  const statusbarErrorIsMirrored =
    (statusbarErrorSource === 'inbox' && activeSurface === 'inbox') ||
    (statusbarErrorSource === 'task' &&
      (activeSurface === 'today' || activeSurface === 'tasks' || taskDialog !== null)) ||
    (statusbarErrorSource === 'note' &&
      (activeSurface === 'notes' || activeSurface === 'assistant' || activeSurface === 'inbox')) ||
    (statusbarErrorSource === 'automation' && activeSurface === 'automations');
  const focusDialogOpen =
    focusDialog !== null &&
    isFocusDialogActivationCurrent(
      focusDialog.activation,
      focusActivation,
      snapshot?.currentWorkspaceId ?? null,
    );
  const overlayOpen =
    paletteOpen ||
    archiveManager.open ||
    workspaceDialog !== null ||
    quickCaptureTarget !== null ||
    taskDialog !== null ||
    scheduleDialog !== null ||
    automationDialog !== null ||
    focusDialogOpen ||
    dataState.importPreview !== null;
  const invalidateInboxCapture = useCallback((): void => {
    inboxCaptureCoordinator.invalidate();
    inboxCapturePublicationGate.clear();
    inboxCaptureFeedbackRef.current = null;
    setInboxCaptureFeedbackState(null);
    setInboxCaptureSyncWarningState(null);
  }, [inboxCaptureCoordinator, inboxCapturePublicationGate]);
  const invalidateInboxConversion = useCallback((): void => {
    inboxConversionNavigation.invalidate();
    inboxConversionRequestCoordinator.invalidate();
    inboxConversionPublicationGate.clear();
    inboxConversionFeedbackRef.current = null;
    inboxConversionSyncWarningRef.current = null;
    setInboxConversionFeedbackState(null);
    setInboxConversionSyncWarningState(null);
  }, [
    inboxConversionNavigation,
    inboxConversionPublicationGate,
    inboxConversionRequestCoordinator,
  ]);
  const finishInboxConversionRequest = useCallback(
    (intent: InboxConversionRequestIntent): void => {
      inboxConversionRequestCoordinator.end(intent);
      const workspaceId = intent.workspace.workspaceId;
      if (workspaceId === null) return;
      setPendingInboxConversionIntents((current) => {
        if (current.get(workspaceId) !== intent) return current;
        const next = new Map(current);
        next.delete(workspaceId);
        return next;
      });
    },
    [inboxConversionRequestCoordinator],
  );
  const publishInboxConversionPublication = useCallback(
    (publication: InboxConversionPublication): void => {
      const activation =
        publication.kind === 'feedback' ? publication.activation : publication.warning.activation;
      const feedback =
        publication.kind === 'feedback' ? publication.feedback : publication.warning.feedback;
      if (
        activation !== inboxConversionActivationRef.current ||
        !inboxConversionRequestCoordinator.isGenerationCurrent(
          feedback.requestGeneration,
          activation,
        )
      ) {
        return;
      }

      if (publication.kind === 'feedback') {
        inboxConversionFeedbackRef.current = publication.feedback;
        inboxConversionSyncWarningRef.current = null;
        setInboxConversionSyncWarningState(null);
        setInboxConversionFeedbackState({
          activation,
          feedback: publication.feedback,
        });
        return;
      }

      inboxConversionFeedbackRef.current = null;
      inboxConversionSyncWarningRef.current = publication.warning;
      setInboxConversionFeedbackState(null);
      setInboxConversionSyncWarningState(publication.warning);
    },
    [inboxConversionRequestCoordinator],
  );
  const closeTaskDialog = useCallback((): void => {
    if (taskDialog?.mode === 'convert') taskController.clearOperationError();
    setTaskDialog(null);
    const publication = inboxConversionPublicationGate.take(
      false,
      inboxConversionActivationRef.current,
    );
    if (publication !== null) publishInboxConversionPublication(publication);
  }, [
    inboxConversionPublicationGate,
    publishInboxConversionPublication,
    taskController,
    taskDialog,
  ]);
  const publishInboxCapturePublication = useCallback(
    (publication: InboxCapturePublication): void => {
      const activation =
        publication.kind === 'feedback' ? publication.activation : publication.warning.activation;
      const requestGeneration =
        publication.kind === 'feedback'
          ? publication.feedback.requestGeneration
          : publication.warning.requestGeneration;
      if (
        activation !== inboxCaptureActivationRef.current ||
        !inboxCaptureCoordinator.isGenerationCurrent(requestGeneration, activation)
      ) {
        return;
      }

      if (publication.kind === 'feedback') {
        inboxCaptureFeedbackRef.current = publication.feedback;
        setInboxCaptureSyncWarningState(null);
        setInboxCaptureFeedbackState({
          activation,
          feedback: publication.feedback,
        });
        return;
      }

      inboxCaptureFeedbackRef.current = null;
      setInboxCaptureFeedbackState(null);
      setInboxCaptureSyncWarningState(publication.warning);
    },
    [inboxCaptureCoordinator],
  );
  const closeQuickCaptureDialog = useCallback((): void => {
    setQuickCaptureTarget(null);
    const publication = inboxCapturePublicationGate.take(false, inboxCaptureActivationRef.current);
    if (publication !== null) publishInboxCapturePublication(publication);
  }, [inboxCapturePublicationGate, publishInboxCapturePublication]);
  const invalidateAutomationCreate = useCallback((): void => {
    automationCreateCoordinator.invalidate();
    automationCreateFeedbackRef.current = null;
    setAutomationCreateFeedbackState(null);
    setAutomationCreateSyncWarningState(null);
  }, [automationCreateCoordinator]);
  const invalidateScheduleCreate = useCallback((): void => {
    scheduleCreateCoordinator.invalidate();
    scheduleCreatePublicationGate.clear();
    scheduleCreateFeedbackRef.current = null;
    setScheduleCreateFeedbackState(null);
    setScheduleCreateSyncWarningState(null);
  }, [scheduleCreateCoordinator, scheduleCreatePublicationGate]);
  const closeScheduleDialog = useCallback((): void => {
    setScheduleDialog(null);
    const activation = scheduleCreateActivationRef.current;
    const publication = scheduleCreatePublicationGate.take(false, activation);
    if (publication === null) return;

    const requestGeneration =
      publication.kind === 'feedback'
        ? publication.feedback.requestGeneration
        : publication.warning.requestGeneration;
    const publicationActivation =
      publication.kind === 'feedback' ? publication.activation : publication.warning.activation;
    if (!scheduleCreateCoordinator.isGenerationCurrent(requestGeneration, publicationActivation)) {
      return;
    }

    if (publication.kind === 'feedback') {
      if (!isScheduleCreateTodayDateCurrent(publication.todayDate, new Date())) {
        setScheduleCreateSyncWarningState({
          activation: publication.activation,
          requestGeneration: publication.feedback.requestGeneration,
          createdScheduleId: publication.feedback.createdScheduleId,
          title: publication.feedback.title,
          scheduledFor: publication.feedback.scheduledFor,
          startMinute: publication.feedback.startMinute,
          endMinute: publication.feedback.endMinute,
          message:
            '日程已创建，但日期窗口已经变化，当前计划未能安全确认。请重新读取后查看，避免重复创建。',
        });
        return;
      }
      scheduleCreateFeedbackRef.current = publication.feedback;
      setScheduleCreateFeedbackState({
        activation: publication.activation,
        feedback: publication.feedback,
      });
      return;
    }
    setScheduleCreateSyncWarningState(publication.warning);
  }, [scheduleCreateCoordinator, scheduleCreatePublicationGate]);
  useLayoutEffect(() => {
    automationOutputActivationRef.current = automationOutputActivation;
    automationRunFeedbackRef.current = visibleAutomationRunFeedback;
    currentSurfaceRef.current = activeSurface;
    automationOutputNavigation.invalidate();
  }, [
    activeSurface,
    automationOutputActivation,
    automationOutputNavigation,
    overlayOpen,
    visibleAutomationRunFeedback,
  ]);
  useLayoutEffect(() => {
    const previousActivation = inboxCaptureActivationRef.current;
    const previousSurface = inboxCaptureSurfaceRef.current;
    inboxCaptureActivationRef.current = inboxCaptureActivation;
    inboxCaptureFeedbackRef.current = visibleInboxCaptureFeedback;
    inboxCaptureSurfaceRef.current = activeSurface;
    if (previousSurface !== activeSurface) {
      inboxCaptureSurfaceGenerationRef.current += 1;
    }
    if (previousActivation !== inboxCaptureActivation) {
      invalidateInboxCapture();
    } else if (previousSurface !== activeSurface || overlayOpen) {
      inboxCaptureCoordinator.cancelOpen();
    }
  }, [
    activeSurface,
    inboxCaptureActivation,
    inboxCaptureCoordinator,
    invalidateInboxCapture,
    overlayOpen,
    visibleInboxCaptureFeedback,
  ]);
  useLayoutEffect(() => {
    const previousActivation = taskCreateActivationRef.current;
    const previousSurface = taskCreateSurfaceRef.current;
    taskCreateActivationRef.current = taskCreateActivation;
    taskCreateFeedbackRef.current = visibleTaskCreateFeedback;
    taskCreateSurfaceRef.current = activeSurface;
    if (previousActivation !== taskCreateActivation) {
      taskCreateCoordinator.invalidate();
    } else if (previousSurface !== activeSurface || overlayOpen) {
      taskCreateCoordinator.cancelOpen();
    }
  }, [
    activeSurface,
    overlayOpen,
    taskCreateActivation,
    taskCreateCoordinator,
    visibleTaskCreateFeedback,
  ]);
  useLayoutEffect(() => {
    const previousActivation = automationCreateActivationRef.current;
    const previousSurface = automationCreateSurfaceRef.current;
    automationCreateActivationRef.current = automationCreateActivation;
    automationCreateFeedbackRef.current = visibleAutomationCreateFeedback;
    automationCreateSurfaceRef.current = activeSurface;
    if (previousActivation !== automationCreateActivation) {
      invalidateAutomationCreate();
    } else if (previousSurface !== activeSurface || overlayOpen) {
      automationCreateCoordinator.cancelOpen();
    }
  }, [
    activeSurface,
    automationCreateActivation,
    automationCreateCoordinator,
    invalidateAutomationCreate,
    overlayOpen,
    visibleAutomationCreateFeedback,
  ]);
  useLayoutEffect(() => {
    const previousActivation = scheduleCreateActivationRef.current;
    const previousSurface = scheduleCreateSurfaceRef.current;
    scheduleCreateActivationRef.current = scheduleCreateActivation;
    scheduleCreateFeedbackRef.current = visibleScheduleCreateFeedback;
    scheduleCreateSurfaceRef.current = activeSurface;
    if (previousActivation !== scheduleCreateActivation) {
      invalidateScheduleCreate();
    } else if (previousSurface !== activeSurface || overlayOpen) {
      scheduleCreateCoordinator.cancelOpen();
    }
  }, [
    activeSurface,
    invalidateScheduleCreate,
    overlayOpen,
    scheduleCreateActivation,
    scheduleCreateCoordinator,
    visibleScheduleCreateFeedback,
  ]);
  useLayoutEffect(() => {
    scheduleMutationActivationRef.current = scheduleController.activation;
    scheduleMutationSyncWarningRef.current = visibleScheduleMutationSyncWarning;
  }, [scheduleController.activation, visibleScheduleMutationSyncWarning]);
  useLayoutEffect(() => {
    const previousActivation = inboxConversionActivationRef.current;
    inboxConversionActivationRef.current = inboxController.activation;
    inboxConversionFeedbackRef.current = visibleInboxConversionFeedback;
    inboxConversionSyncWarningRef.current = visibleInboxConversionSyncWarning;
    inboxConversionSurfaceRef.current = activeSurface;
    currentSurfaceRef.current = activeSurface;
    inboxConversionNavigation.invalidate();
    if (previousActivation !== inboxController.activation) invalidateInboxConversion();
  }, [
    activeSurface,
    inboxController.activation,
    invalidateInboxConversion,
    inboxConversionNavigation,
    overlayOpen,
    visibleInboxConversionFeedback,
    visibleInboxConversionSyncWarning,
  ]);
  useLayoutEffect(() => {
    assistantSavedNotesRef.current = assistantSavedNotes;
  }, [assistantSavedNotes]);
  useLayoutEffect(() => {
    assistantSavedNoteActivationRef.current = assistantSavedNoteActivation;
    assistantResponseKeyRef.current = currentAssistantResponseKey;
    assistantSavedNoteTargetRef.current = currentAssistantSavedNote;
    currentSurfaceRef.current = activeSurface;
    assistantSavedNoteNavigation.invalidate();
  }, [
    activeSurface,
    assistantSavedNoteActivation,
    assistantSavedNoteNavigation,
    currentAssistantResponseKey,
    currentAssistantSavedNote,
    overlayOpen,
  ]);
  useLayoutEffect(() => {
    const previousActivation = focusTaskCompletionActivationRef.current;
    const previousKey = focusTaskCompletionNoticeRef.current?.key ?? null;
    const previousSurface = focusTaskCompletionSurfaceRef.current;
    focusTaskCompletionActivationRef.current = focusActivation;
    focusTaskCompletionNoticeRef.current = focusTaskCompletion;
    focusTaskCompletionSurfaceRef.current = activeSurface;
    if (
      previousActivation !== focusActivation ||
      previousKey !== (focusTaskCompletion?.key ?? null) ||
      previousSurface !== activeSurface
    ) {
      focusTaskCompletionCoordinator.invalidate();
    }
  }, [activeSurface, focusActivation, focusTaskCompletion, focusTaskCompletionCoordinator]);
  const terminalMaximum = Math.min(2160, Math.max(180, viewportHeight - 180));
  const effectiveTerminalHeight = clamp(terminalHeight, 180, terminalMaximum);

  const updateNoteDraftDirty = useCallback(
    (dirty: boolean) => synchronizeDirtyDraft(noteDraftDirtyRef, setNoteDraftDirty, dirty),
    [],
  );
  const publishNoteCreateSyncWarningForActivation = useCallback(
    (activation: NoteWorkspaceIdentity, warning: NoteCreateSyncWarningTarget): void => {
      if (noteCreateActivationRef.current !== activation) return;
      updateNoteDraftDirty(false);
      const publication = { activation, ...warning };
      noteCreateSyncWarningRef.current = publication;
      setNoteCreateSyncWarningState(publication);
    },
    [updateNoteDraftDirty],
  );
  const publishNoteCreateSyncWarning = useCallback(
    (warning: NoteCreateSyncWarningTarget): void => {
      publishNoteCreateSyncWarningForActivation(noteCreateActivation, warning);
    },
    [noteCreateActivation, publishNoteCreateSyncWarningForActivation],
  );
  const resolveNoteCreateSyncWarning = useCallback(
    (warning: NoteCreateSyncWarningTarget): void => {
      const activation = noteCreateActivation;
      if (noteCreateActivationRef.current !== activation) return;
      const next = clearResolvedNoteCreateSyncWarning(
        noteCreateSyncWarningRef.current,
        activation,
        warning,
      );
      noteCreateSyncWarningRef.current = next;
      setNoteCreateSyncWarningState(next);
    },
    [noteCreateActivation],
  );
  const publishNoteMutationSyncWarningForActivation = useCallback(
    (
      activation: NoteWorkspaceIdentity,
      warning: NoteMutationSyncWarningTarget,
      focusActionOnMount: boolean,
    ): void => {
      if (noteCreateActivationRef.current !== activation) return;
      updateNoteDraftDirty(false);
      const current = noteMutationSyncWarningRef.current;
      const publication: NoteMutationSyncWarningPublication =
        current?.activation === activation &&
        current.kind === warning.kind &&
        current.intent === warning.intent &&
        current.resultSnapshot === warning.resultSnapshot
          ? {
              ...current,
              focusActionOnMount: current.focusActionOnMount || focusActionOnMount,
            }
          : {
              activation,
              ...warning,
              focusActionOnMount,
              refreshing: false,
              refreshError: null,
            };
      noteMutationSyncWarningRef.current = publication;
      setNoteMutationSyncWarningState(publication);
    },
    [updateNoteDraftDirty],
  );
  const publishNoteMutationSyncWarning = useCallback(
    (warning: NoteMutationSyncWarningTarget, focusActionOnMount: boolean): void => {
      publishNoteMutationSyncWarningForActivation(
        noteCreateActivation,
        warning,
        focusActionOnMount,
      );
    },
    [noteCreateActivation, publishNoteMutationSyncWarningForActivation],
  );
  const noteWriteIsBlocked = useCallback((activation: NoteWorkspaceIdentity): boolean => {
    const workspaceId = activation.workspaceId;
    const inboxWarning = inboxConversionSyncWarningRef.current;
    const automationPublication =
      workspaceId === null ? null : automationRunPublicationsRef.current.get(workspaceId);
    return (
      noteCreateSyncWarningRef.current?.activation === activation ||
      noteMutationSyncWarningRef.current?.activation === activation ||
      (workspaceId !== null &&
        inboxWarning?.activation.workspaceId === workspaceId &&
        inboxWarning.feedback.outputKind === 'note') ||
      (automationPublication?.kind === 'warning' &&
        automationPublication.feedback.outputKind === 'note')
    );
  }, []);
  const noteWorkspaceChangeIsBlocked = useCallback((): boolean => {
    const activation = noteCreateActivationRef.current;
    return (
      noteMutationCoordinator.isPending(activation.workspaceId) || noteWriteIsBlocked(activation)
    );
  }, [noteMutationCoordinator, noteWriteIsBlocked]);
  const assertNoteOutputNavigationAvailable = useCallback(
    (workspaceId: string): void => {
      const activation = noteCreateActivationRef.current;
      if (activation.workspaceId !== workspaceId) {
        throw new Error('当前工作区已变化，无法打开刚创建的笔记。');
      }
      if (noteMutationCoordinator.isPending(workspaceId) || noteWriteIsBlocked(activation)) {
        throw new Error('笔记写入仍在确认，请先返回笔记页面完成重新读取，再打开该笔记。');
      }
    },
    [noteMutationCoordinator, noteWriteIsBlocked],
  );
  const noteWorkspaceChangeBlocked = noteWorkspaceChangeIsBlocked();
  const createNote = useCallback(
    async (title: string, body: string): Promise<NoteCreateCommit> => {
      const activation = noteCreateActivationRef.current;
      if (noteWriteIsBlocked(activation)) {
        throw new Error('请先重新读取上一项已提交的笔记写入，再继续创建笔记。');
      }
      const intent = noteMutationCoordinator.begin(activation, 'create');
      if (intent === null) throw new Error('这个工作区正在处理另一项笔记写入。');
      try {
        const commit = await noteController.create(title, body);
        const publicationActivation = noteCreateActivationRef.current;
        if (
          !commit.committed &&
          noteMutationCoordinator.canPublishWarning(intent, publicationActivation)
        ) {
          publishNoteCreateSyncWarningForActivation(publicationActivation, {
            result: commit.result,
            title,
            body,
            message:
              commit.reconciliationWarning ??
              '笔记已创建，但当前笔记列表未能同步。请重新读取后查看，避免重复创建。',
          });
        }
        return commit;
      } finally {
        noteMutationCoordinator.end(intent);
      }
    },
    [
      noteController,
      noteMutationCoordinator,
      noteWriteIsBlocked,
      publishNoteCreateSyncWarningForActivation,
    ],
  );
  const recoverCreatedNote = useCallback(
    async (result: Parameters<typeof noteController.recoverCreatedNote>[0]) => {
      const activation = noteCreateActivationRef.current;
      const warning = noteCreateSyncWarningRef.current;
      if (
        warning?.activation !== activation ||
        warning.result.createdNoteId !== result.createdNoteId
      ) {
        return null;
      }
      const coordinatorIntent = noteMutationCoordinator.begin(activation, 'recover');
      if (coordinatorIntent === null) {
        throw new Error('这个工作区正在确认另一项笔记写入。');
      }
      try {
        return await noteController.recoverCreatedNote(result);
      } finally {
        noteMutationCoordinator.end(coordinatorIntent);
      }
    },
    [noteController, noteMutationCoordinator],
  );
  const updateNote = useCallback(
    async (note: Parameters<typeof noteController.update>[0], title: string, body: string) => {
      const activation = noteCreateActivationRef.current;
      if (noteWriteIsBlocked(activation)) {
        throw new Error('请先重新读取上一项已提交的笔记写入，再继续保存。');
      }
      const coordinatorIntent = noteMutationCoordinator.begin(activation, 'update');
      if (coordinatorIntent === null) {
        throw new Error('这个工作区正在处理另一项笔记写入。');
      }
      try {
        const commit = await noteController.update(note, title, body);
        const publicationActivation = noteCreateActivationRef.current;
        if (
          !commit.committed &&
          noteMutationCoordinator.canPublishWarning(coordinatorIntent, publicationActivation)
        ) {
          publishNoteMutationSyncWarningForActivation(
            publicationActivation,
            noteUpdateSyncWarning(commit),
            false,
          );
        }
        return commit;
      } finally {
        noteMutationCoordinator.end(coordinatorIntent);
      }
    },
    [
      noteController,
      noteMutationCoordinator,
      noteWriteIsBlocked,
      publishNoteMutationSyncWarningForActivation,
    ],
  );
  const archiveNote = useCallback(
    async (note: Parameters<typeof noteController.archive>[0]) => {
      const activation = noteCreateActivationRef.current;
      if (noteWriteIsBlocked(activation)) {
        throw new Error('请先重新读取上一项已提交的笔记写入，再继续归档。');
      }
      const coordinatorIntent = noteMutationCoordinator.begin(activation, 'archive');
      if (coordinatorIntent === null) {
        throw new Error('这个工作区正在处理另一项笔记写入。');
      }
      try {
        const commit = await noteController.archive(note);
        const publicationActivation = noteCreateActivationRef.current;
        if (
          !commit.committed &&
          noteMutationCoordinator.canPublishWarning(coordinatorIntent, publicationActivation)
        ) {
          publishNoteMutationSyncWarningForActivation(
            publicationActivation,
            noteArchiveSyncWarning(commit),
            false,
          );
        }
        return commit;
      } finally {
        noteMutationCoordinator.end(coordinatorIntent);
      }
    },
    [
      noteController,
      noteMutationCoordinator,
      noteWriteIsBlocked,
      publishNoteMutationSyncWarningForActivation,
    ],
  );
  const refreshNoteMutationSyncWarning = useCallback(
    async (warning: NoteMutationSyncWarningTarget): Promise<NoteMutationRecovery> => {
      const publication = noteMutationSyncWarningRef.current;
      if (publication === null || publication !== warning) {
        throw new Error('这项笔记同步状态已被较新的结果替代。');
      }
      const coordinatorIntent = noteMutationCoordinator.begin(publication.activation, 'recover');
      if (coordinatorIntent === null) {
        throw new Error('这个工作区正在处理另一项笔记写入。');
      }
      const isSamePublication = (
        current: NoteMutationSyncWarningPublication | null,
      ): current is NoteMutationSyncWarningPublication =>
        current?.activation === publication.activation &&
        current.kind === publication.kind &&
        current.intent === publication.intent &&
        current.resultSnapshot === publication.resultSnapshot;
      const updatePublication = (
        update: (current: NoteMutationSyncWarningPublication) => NoteMutationSyncWarningPublication,
      ): void => {
        const current = noteMutationSyncWarningRef.current;
        if (!isSamePublication(current)) return;
        const next = update(current);
        noteMutationSyncWarningRef.current = next;
        setNoteMutationSyncWarningState(next);
      };
      updatePublication((current) => ({
        ...current,
        refreshing: true,
        refreshError: null,
        focusActionOnMount: false,
      }));
      try {
        const recovery = await noteController.recoverNoteMutation(publication);
        if (
          !noteMutationCoordinator.isCurrent(coordinatorIntent, noteCreateActivationRef.current) ||
          !isSamePublication(noteMutationSyncWarningRef.current)
        ) {
          throw new Error('这项笔记同步状态已被较新的结果替代。');
        }
        const recovered =
          recovery.kind === 'update'
            ? recovery.committed &&
              recovery.updatedNote !== null &&
              recovery.updatedNote.id === publication.intent.originalNote.id
            : recovery.committed && recovery.confirmed;
        if (!recovered) {
          throw new Error(
            publication.kind === 'update'
              ? '重新读取后仍无法确认刚保存的笔记。请稍后再试；笔记已经保存，请不要再次保存。'
              : '重新读取后仍无法确认已归档的笔记。请稍后再试；笔记已经归档，请不要再次归档。',
          );
        }
        if (isSamePublication(noteMutationSyncWarningRef.current)) {
          noteMutationSyncWarningRef.current = null;
          setNoteMutationSyncWarningState(null);
        }
        return recovery;
      } catch (error) {
        updatePublication((current) => ({
          ...current,
          refreshing: false,
          refreshError:
            error instanceof Error && error.message.trim().length > 0
              ? error.message
              : '重新读取笔记失败，请稍后再试。',
        }));
        throw error;
      } finally {
        noteMutationCoordinator.end(coordinatorIntent);
        updatePublication((current) =>
          current.refreshing ? { ...current, refreshing: false } : current,
        );
      }
    },
    [noteController, noteMutationCoordinator],
  );
  const invalidateNoteMutations = useCallback((): void => {
    noteMutationCoordinator.invalidateAll();
    noteCreateSyncWarningRef.current = null;
    noteMutationSyncWarningRef.current = null;
    setNoteCreateSyncWarningState(null);
    setNoteMutationSyncWarningState(null);
  }, [noteMutationCoordinator]);
  const publishScheduleMutationSyncWarning = useCallback(
    (
      activation: ScheduleWorkspaceIdentity,
      warning: ScheduleMutationSyncWarningTarget,
      focusActionOnMount: boolean,
    ): void => {
      if (scheduleMutationActivationRef.current.workspaceId !== activation.workspaceId) return;
      const current = scheduleMutationSyncWarningRef.current;
      const publication: ScheduleMutationSyncWarningPublication =
        current?.activation === activation &&
        current.kind === warning.kind &&
        current.intent === warning.intent &&
        current.resultSnapshot === warning.resultSnapshot
          ? {
              ...current,
              focusActionOnMount: current.focusActionOnMount || focusActionOnMount,
            }
          : {
              activation,
              ...warning,
              focusActionOnMount,
              refreshing: false,
              refreshError: null,
            };
      scheduleMutationSyncWarningRef.current = publication;
      setScheduleMutationSyncWarningState(publication);
    },
    [],
  );
  const scheduleWriteIsBlocked = useCallback((activation: ScheduleWorkspaceIdentity): boolean => {
    const warning = scheduleMutationSyncWarningRef.current;
    return (
      warning !== null &&
      warning.activation.workspaceId !== null &&
      warning.activation.workspaceId === activation.workspaceId
    );
  }, []);
  const scheduleWorkspaceChangeIsBlocked = useCallback((): boolean => {
    const activation = scheduleMutationActivationRef.current;
    return (
      scheduleMutationCoordinator.isPending(activation.workspaceId) ||
      scheduleWriteIsBlocked(activation)
    );
  }, [scheduleMutationCoordinator, scheduleWriteIsBlocked]);
  const scheduleWorkspaceChangeBlocked =
    scheduleNavigationPending || scheduleWorkspaceChangeIsBlocked();
  const updateSchedule = useCallback(
    async (
      item: Parameters<typeof scheduleController.update>[0],
      expectedDate: string,
      title: string,
      kind: ScheduleKind,
      startMinute: number,
      endMinute: number,
    ): Promise<ScheduleUpdateCommit> => {
      const activation = scheduleMutationActivationRef.current;
      if (scheduleWriteIsBlocked(activation)) {
        throw new Error('请先重新读取上一项已提交的日程写入，再继续保存。');
      }
      const coordinatorIntent = scheduleMutationCoordinator.begin(activation, 'update');
      if (coordinatorIntent === null) {
        throw new Error('这个工作区正在处理另一项日程写入。');
      }
      try {
        const commit = await scheduleController.update(
          item,
          expectedDate,
          title,
          kind,
          startMinute,
          endMinute,
        );
        const publicationActivation = scheduleMutationActivationRef.current;
        if (
          !commit.committed &&
          scheduleMutationCoordinator.canPublishWarning(coordinatorIntent, publicationActivation)
        ) {
          publishScheduleMutationSyncWarning(
            publicationActivation,
            scheduleUpdateSyncWarning(commit),
            true,
          );
        }
        return commit;
      } finally {
        scheduleMutationCoordinator.end(coordinatorIntent);
      }
    },
    [
      publishScheduleMutationSyncWarning,
      scheduleController,
      scheduleMutationCoordinator,
      scheduleWriteIsBlocked,
    ],
  );
  const archiveSchedule = useCallback(
    async (
      item: Parameters<typeof scheduleController.archive>[0],
      expectedDate: string,
    ): Promise<ScheduleArchiveCommit> => {
      const activation = scheduleMutationActivationRef.current;
      if (scheduleWriteIsBlocked(activation)) {
        throw new Error('请先重新读取上一项已提交的日程写入，再继续归档。');
      }
      const coordinatorIntent = scheduleMutationCoordinator.begin(activation, 'archive');
      if (coordinatorIntent === null) {
        throw new Error('这个工作区正在处理另一项日程写入。');
      }
      try {
        const commit = await scheduleController.archive(item, expectedDate);
        const publicationActivation = scheduleMutationActivationRef.current;
        if (
          !commit.committed &&
          scheduleMutationCoordinator.canPublishWarning(coordinatorIntent, publicationActivation)
        ) {
          publishScheduleMutationSyncWarning(
            publicationActivation,
            scheduleArchiveSyncWarning(commit),
            true,
          );
        }
        return commit;
      } finally {
        scheduleMutationCoordinator.end(coordinatorIntent);
      }
    },
    [
      publishScheduleMutationSyncWarning,
      scheduleController,
      scheduleMutationCoordinator,
      scheduleWriteIsBlocked,
    ],
  );
  const refreshScheduleMutationSyncWarning = useCallback(
    async (warning: ScheduleMutationSyncWarningPublication): Promise<ScheduleMutationRecovery> => {
      const publication = scheduleMutationSyncWarningRef.current;
      if (publication === null || publication !== warning) {
        throw new Error('这项日程同步状态已被较新的结果替代。');
      }
      const coordinatorIntent = scheduleMutationCoordinator.begin(
        publication.activation,
        'recover',
      );
      if (coordinatorIntent === null) {
        throw new Error('这个工作区正在处理另一项日程写入。');
      }
      const isSamePublication = (
        current: ScheduleMutationSyncWarningPublication | null,
      ): current is ScheduleMutationSyncWarningPublication =>
        current?.activation === publication.activation &&
        current.kind === publication.kind &&
        current.intent === publication.intent &&
        current.resultSnapshot === publication.resultSnapshot;
      const updatePublication = (
        update: (
          current: ScheduleMutationSyncWarningPublication,
        ) => ScheduleMutationSyncWarningPublication,
      ): void => {
        const current = scheduleMutationSyncWarningRef.current;
        if (!isSamePublication(current)) return;
        const next = update(current);
        scheduleMutationSyncWarningRef.current = next;
        setScheduleMutationSyncWarningState(next);
      };
      updatePublication((current) => ({
        ...current,
        refreshing: true,
        refreshError: null,
        focusActionOnMount: false,
      }));
      try {
        const recovery = await scheduleController.recoverScheduleMutation(publication);
        if (
          !scheduleMutationCoordinator.isCurrent(
            coordinatorIntent,
            scheduleMutationActivationRef.current,
          ) ||
          !isSamePublication(scheduleMutationSyncWarningRef.current)
        ) {
          throw new Error('这项日程同步状态已被较新的结果替代。');
        }
        const recovered =
          recovery.kind === 'update'
            ? recovery.committed &&
              recovery.updatedSchedule !== null &&
              recovery.updatedSchedule.id === publication.intent.originalSchedule.id
            : recovery.committed && recovery.confirmed;
        if (!recovered) {
          throw new Error(
            publication.kind === 'update'
              ? '重新读取后仍无法确认刚保存的日程。请稍后再试；日程已经保存，请不要再次保存。'
              : '重新读取后仍无法确认已归档的日程。请稍后再试；日程已经归档，请不要再次归档。',
          );
        }
        if (isSamePublication(scheduleMutationSyncWarningRef.current)) {
          scheduleMutationSyncWarningRef.current = null;
          setScheduleMutationSyncWarningState(null);
        }
        return recovery;
      } catch (error) {
        updatePublication((current) => ({
          ...current,
          refreshing: false,
          refreshError:
            error instanceof Error && error.message.trim().length > 0
              ? error.message
              : '重新读取日程失败，请稍后再试。',
        }));
        throw error;
      } finally {
        scheduleMutationCoordinator.end(coordinatorIntent);
        updatePublication((current) =>
          current.refreshing ? { ...current, refreshing: false } : current,
        );
      }
    },
    [scheduleController, scheduleMutationCoordinator],
  );
  const invalidateScheduleMutations = useCallback((): void => {
    scheduleMutationCoordinator.invalidateAll();
    scheduleMutationSyncWarningRef.current = null;
    scheduleNavigationIntentRef.current = null;
    setScheduleMutationSyncWarningState(null);
    setScheduleNavigationPending(false);
  }, [scheduleMutationCoordinator]);
  const restoreScheduleMutationWarningFocus = useCallback(
    (warning: ScheduleMutationSyncWarningPublication): void => {
      if (warning.kind === 'update') {
        const target = Array.from(
          document.querySelectorAll<HTMLElement>('[data-schedule-id]'),
        ).find(
          (element) =>
            element.dataset.scheduleId === warning.intent.originalSchedule.id &&
            !(element instanceof HTMLButtonElement && element.disabled),
        );
        if (target) {
          target.focus({ preventScroll: true });
          return;
        }
      }
      const fallback = document.querySelector<HTMLElement>(
        '[data-schedule-id]:not(:disabled), [data-schedule-create-action]:not(:disabled), .today-dashboard h1, .section-page h1, .activity-rail button[aria-current="page"]',
      );
      if (!fallback) return;
      if (!fallback.hasAttribute('tabindex') && !(fallback instanceof HTMLButtonElement)) {
        fallback.tabIndex = -1;
      }
      fallback.focus({ preventScroll: true });
    },
    [],
  );
  const handleRequestedInboxEntry = useCallback(() => {
    const expectedGeneration = inboxReveal?.generation;
    if (expectedGeneration === undefined) return;
    setInboxReveal((current) =>
      current?.generation === expectedGeneration && !current.handled
        ? { ...current, handled: true }
        : current,
    );
  }, [inboxReveal?.generation]);

  const updatePreferences = workspaceController.updatePreferences;
  const invalidateWorkspacePreferenceEpoch = workspaceController.invalidatePreferenceEpoch;
  const openUrlInWorkspace = useCallback(
    (workspaceId: string, url: string) => {
      if (currentWorkspaceIdRef.current !== workspaceId) return;
      updatePreferences({ browserOpen: true }, true, workspaceId);
      void openBrowserUrlInWorkspace(
        window.workbench.browser,
        workspaceId,
        url,
        () => currentWorkspaceIdRef.current === workspaceId,
      ).catch(() => undefined);
    },
    [updatePreferences],
  );
  const confirmLeaveNoteDraft = useCallback(
    () =>
      !noteDraftDirtyRef.current ||
      window.confirm('当前笔记有尚未保存的更改。要放弃这些更改并继续吗？'),
    [],
  );
  const restoreBackupWithApproval = useCallback(
    async (input: DatabaseBackupRestoreInput): Promise<DatabaseBackupRestoreResult | null> => {
      if (noteMutationCoordinator.isPending(currentWorkspaceIdRef.current)) {
        throw new Error('笔记写入仍在确认，请稍候再恢复备份。');
      }
      if (scheduleMutationCoordinator.isPending(currentWorkspaceIdRef.current)) {
        throw new Error('日程写入仍在确认，请稍候再恢复备份。');
      }
      if (!confirmLeaveNoteDraft()) return null;
      dataReplacementApprovedRef.current = true;
      dataReplacementNoteDiscardApprovedRef.current = true;
      try {
        const result = await restoreBackup(input);
        if (result.status === 'cancelled') {
          dataReplacementApprovedRef.current = false;
          dataReplacementNoteDiscardApprovedRef.current = false;
        } else {
          invalidateWorkspacePreferenceEpoch();
          invalidateNoteMutations();
          invalidateScheduleMutations();
          invalidateManualBackupRecovery();
        }
        return result;
      } catch (error) {
        dataReplacementApprovedRef.current = false;
        dataReplacementNoteDiscardApprovedRef.current = false;
        throw error;
      }
    },
    [
      confirmLeaveNoteDraft,
      invalidateWorkspacePreferenceEpoch,
      invalidateManualBackupRecovery,
      invalidateNoteMutations,
      invalidateScheduleMutations,
      noteMutationCoordinator,
      restoreBackup,
      scheduleMutationCoordinator,
    ],
  );
  const restoreManualBackupSyncWarningFocus = useCallback((): void => {
    const manualBackupAction = document.querySelector<HTMLButtonElement>(
      '[data-backup-create-action="manual"]:not(:disabled)',
    );
    if (manualBackupAction) {
      manualBackupAction.focus({ preventScroll: true });
      return;
    }
    const fallback = document.querySelector<HTMLElement>(
      '.section-page__header h1, .section-page__header h2, main h1, .activity-rail button[aria-current="page"]',
    );
    if (!fallback) return;
    if (!fallback.hasAttribute('tabindex')) fallback.tabIndex = -1;
    fallback.focus({ preventScroll: true });
  }, []);
  const requestActiveView = useCallback(
    (view: AppSurfaceId) => {
      if (view === activeSurface || !confirmLeaveNoteDraft()) return;
      automationOutputNavigation.invalidate();
      automationCreateCoordinator.cancelOpen();
      scheduleCreateCoordinator.cancelOpen();
      assistantSavedNoteNavigation.invalidate();
      inboxCaptureCoordinator.cancelOpen();
      taskCreateCoordinator.cancelOpen();
      inboxConversionNavigation.invalidate();
      if (view === 'assistant') {
        setAssistantSurfaceOpen(true);
      } else {
        setAssistantSurfaceOpen(false);
      }
      if (view !== 'assistant' && view !== activeView) {
        updatePreferences({ activeView: view });
      }
    },
    [
      activeSurface,
      activeView,
      automationCreateCoordinator,
      assistantSavedNoteNavigation,
      automationOutputNavigation,
      confirmLeaveNoteDraft,
      inboxCaptureCoordinator,
      inboxConversionNavigation,
      scheduleCreateCoordinator,
      taskCreateCoordinator,
      updatePreferences,
    ],
  );
  const openAssistant = useCallback(
    (context: AssistantContextReference) => {
      if (!activeWorkspace || !confirmLeaveNoteDraft()) return;
      automationCreateCoordinator.cancelOpen();
      scheduleCreateCoordinator.cancelOpen();
      inboxCaptureCoordinator.cancelOpen();
      inboxConversionNavigation.invalidate();
      setAssistantEntry((current) => ({
        workspaceId: activeWorkspace.id,
        context,
        generation: current.generation + 1,
      }));
      setAssistantSurfaceOpen(true);
    },
    [
      activeWorkspace,
      automationCreateCoordinator,
      confirmLeaveNoteDraft,
      inboxCaptureCoordinator,
      inboxConversionNavigation,
      scheduleCreateCoordinator,
    ],
  );
  const openTerminalSettings = useCallback(() => {
    setSettingsSection('terminal');
    requestActiveView('settings');
  }, [requestActiveView]);
  const openAssistantSettings = useCallback(() => {
    setSettingsSection('assistant');
    requestActiveView('settings');
  }, [requestActiveView]);
  const requestWorkspaceActivation = useCallback(
    (workspaceId: string) => {
      if (workspaceId === currentWorkspaceIdRef.current) return;
      if (noteWorkspaceChangeIsBlocked() || scheduleWorkspaceChangeIsBlocked()) return;
      if (!confirmLeaveNoteDraft()) return;
      searchNavigation.invalidate();
      automationOutputNavigation.invalidate();
      invalidateAutomationCreate();
      invalidateScheduleCreate();
      assistantSavedNoteNavigation.invalidate();
      invalidateInboxCapture();
      taskCreateCoordinator.invalidate();
      invalidateInboxConversion();
      void workspaceController.activate(workspaceId).catch(() => undefined);
    },
    [
      assistantSavedNoteNavigation,
      automationOutputNavigation,
      confirmLeaveNoteDraft,
      invalidateInboxCapture,
      invalidateInboxConversion,
      searchNavigation,
      taskCreateCoordinator,
      invalidateAutomationCreate,
      invalidateScheduleCreate,
      noteWorkspaceChangeIsBlocked,
      scheduleWorkspaceChangeIsBlocked,
      workspaceController,
    ],
  );
  const createWorkspace = useCallback(
    async (name: string, color: WorkspaceColor): Promise<void> => {
      if (noteWorkspaceChangeIsBlocked() || scheduleWorkspaceChangeIsBlocked()) {
        throw new Error('写入仍在确认，请先完成重新读取，再新建工作区。');
      }
      await workspaceController.create(name, color);
    },
    [noteWorkspaceChangeIsBlocked, scheduleWorkspaceChangeIsBlocked, workspaceController],
  );
  const archiveWorkspace = useCallback(
    async (workspaceId: string): Promise<void> => {
      if (
        workspaceId === currentWorkspaceIdRef.current &&
        (noteWorkspaceChangeIsBlocked() || scheduleWorkspaceChangeIsBlocked())
      ) {
        throw new Error('写入仍在确认，请先完成重新读取，再归档当前工作区。');
      }
      await workspaceController.archive(workspaceId);
    },
    [noteWorkspaceChangeIsBlocked, scheduleWorkspaceChangeIsBlocked, workspaceController],
  );
  const openQuickCapture = useCallback(() => {
    if (
      !activeWorkspace ||
      archiveManager.open ||
      workspaceDialog !== null ||
      taskDialog !== null ||
      scheduleDialog !== null ||
      automationDialog !== null ||
      focusDialogOpen ||
      dataState.importPreview !== null ||
      workspaceController.pendingOperation !== null
    ) {
      return;
    }
    inboxCaptureCoordinator.cancelOpen();
    setPaletteOpen(false);
    setQuickCaptureTarget(
      (current) =>
        current ?? { workspaceId: activeWorkspace.id, workspaceName: activeWorkspace.name },
    );
  }, [
    activeWorkspace,
    archiveManager.open,
    automationDialog,
    scheduleDialog,
    dataState.importPreview,
    focusDialogOpen,
    inboxCaptureCoordinator,
    taskDialog,
    workspaceController.pendingOperation,
    workspaceDialog,
  ]);
  const createInboxCapture = useCallback(
    async (
      workspaceId: string,
      content: string,
      category: InboxEntry['category'],
      errorOwner: 'dialog' | 'today' = 'dialog',
    ) => {
      const activation = inboxCaptureActivationRef.current;
      const originSurface = inboxCaptureSurfaceRef.current;
      const originSurfaceGeneration = inboxCaptureSurfaceGenerationRef.current;
      const intent = inboxCaptureCoordinator.beginCapture(activation);
      inboxCapturePublicationGate.clear();
      inboxCaptureFeedbackRef.current = null;
      setInboxCaptureFeedbackState(null);
      setInboxCaptureSyncWarningState(null);
      try {
        const commit = await createInbox(
          workspaceId,
          content,
          category,
          () =>
            inboxCaptureCoordinator.isCaptureCurrent(intent, inboxCaptureActivationRef.current) &&
            errorOwner === 'today' &&
            (inboxCaptureSurfaceRef.current !== originSurface ||
              inboxCaptureSurfaceGenerationRef.current !== originSurfaceGeneration),
        );
        if (!inboxCaptureCoordinator.isCaptureCurrent(intent, inboxCaptureActivationRef.current)) {
          return;
        }
        let publication: InboxCapturePublication;
        if (!commit.committed || commit.createdEntry === null) {
          publication = {
            kind: 'warning',
            warning: {
              activation: intent.workspace,
              requestGeneration: intent.generation,
              createdEntryId: commit.result.createdEntryId,
              content: commit.createdEntry?.content ?? content,
              focusActionOnMount: errorOwner === 'dialog',
              message:
                commit.reconciliationWarning ??
                '记录已创建，但当前收件箱未能同步。请重新读取后查看，避免重复添加。',
            },
          };
        } else {
          const feedback = inboxCaptureCoordinator.createFeedback(
            intent,
            inboxCaptureActivationRef.current,
            commit.createdEntry,
            true,
          );
          publication = {
            kind: 'feedback',
            activation: intent.workspace,
            feedback,
          };
        }
        if (errorOwner === 'dialog') {
          inboxCapturePublicationGate.stage(intent.workspace, publication);
        } else {
          publishInboxCapturePublication(publication);
        }
      } catch (error) {
        if (
          !inboxCaptureCoordinator.isCaptureCurrent(intent, inboxCaptureActivationRef.current) ||
          error instanceof InboxCaptureSupersededError
        ) {
          return;
        }
        throw error;
      } finally {
        inboxCaptureCoordinator.endCapture(intent);
      }
    },
    [
      createInbox,
      inboxCaptureCoordinator,
      inboxCapturePublicationGate,
      publishInboxCapturePublication,
    ],
  );
  const openInboxCapture = useCallback(
    async (feedback: InboxCaptureFeedback): Promise<void> => {
      if (!confirmLeaveNoteDraft()) {
        throw new Error('已取消打开收件箱记录；当前笔记仍保留未保存的更改。');
      }
      automationCreateCoordinator.cancelOpen();
      taskCreateCoordinator.cancelOpen();
      try {
        const intent = inboxCaptureCoordinator.beginOpen(
          inboxCaptureActivationRef.current,
          feedback,
        );
        const assertCurrent = () =>
          inboxCaptureCoordinator.assertOpenCurrent(
            intent,
            inboxCaptureActivationRef.current,
            inboxCaptureFeedbackRef.current,
          );
        const target = await resolveInboxCaptureNavigationTarget(
          intent,
          prepareInboxSnapshotRefresh,
          assertCurrent,
        );
        assertCurrent();
        if (!activeWorkspace || activeWorkspace.id !== target.workspaceId) {
          throw new InboxCaptureSupersededError();
        }

        setPaletteOpen(false);
        setAssistantSurfaceOpen(false);
        setRequestedNoteId(null);
        updatePreferences({ activeView: 'inbox' }, true, target.workspaceId);
        setInboxReveal({
          workspaceId: target.workspaceId,
          entryId: target.entry.id,
          generation: intent.generation,
          handled: false,
        });
        inboxCaptureFeedbackRef.current = null;
        setInboxCaptureFeedbackState((current) =>
          current?.feedback === feedback ? null : current,
        );
      } catch (error) {
        throw inboxCaptureNavigationError(error);
      }
    },
    [
      activeWorkspace,
      automationCreateCoordinator,
      confirmLeaveNoteDraft,
      inboxCaptureCoordinator,
      prepareInboxSnapshotRefresh,
      taskCreateCoordinator,
      updatePreferences,
    ],
  );
  const dismissInboxCapture = useCallback(
    (feedback: InboxCaptureFeedback): boolean => {
      if (
        !inboxCaptureCoordinator.dismiss(
          feedback,
          inboxCaptureActivationRef.current,
          inboxCaptureFeedbackRef.current,
        )
      ) {
        return false;
      }
      inboxCaptureFeedbackRef.current = null;
      setInboxCaptureFeedbackState((current) => (current?.feedback === feedback ? null : current));
      return true;
    },
    [inboxCaptureCoordinator],
  );
  const restoreInboxCaptureFocus = useCallback((): void => {
    const todayInput =
      inboxCaptureSurfaceRef.current === 'today'
        ? document.getElementById('quick-capture-input')
        : null;
    const fallback =
      todayInput instanceof HTMLElement
        ? todayInput
        : document.querySelector<HTMLElement>('.page-chrome__actions button:not(:disabled)');
    fallback?.focus({ preventScroll: true });
  }, []);
  const dismissInboxCaptureSyncWarning = useCallback(
    (warning: InboxCaptureSyncWarningState): void => {
      if (
        warning.activation !== inboxCaptureActivationRef.current ||
        !inboxCaptureCoordinator.isGenerationCurrent(warning.requestGeneration, warning.activation)
      ) {
        return;
      }
      invalidateInboxCapture();
      window.requestAnimationFrame(restoreInboxCaptureFocus);
    },
    [inboxCaptureCoordinator, invalidateInboxCapture, restoreInboxCaptureFocus],
  );
  const refreshInboxCaptureSyncWarning = useCallback(
    async (warning: InboxCaptureSyncWarningState): Promise<void> => {
      if (
        warning.activation !== inboxCaptureActivationRef.current ||
        !inboxCaptureCoordinator.isGenerationCurrent(warning.requestGeneration, warning.activation)
      ) {
        return;
      }
      const intent = inboxCaptureCoordinator.beginSyncRefresh(
        warning.activation,
        warning.requestGeneration,
      );
      const assertCurrent = (): void =>
        inboxCaptureCoordinator.assertSyncRefreshCurrent(intent, inboxCaptureActivationRef.current);
      try {
        const createdEntry = await resolveInboxCaptureSyncRefreshEntry(
          intent,
          warning.createdEntryId,
          prepareInboxSnapshotRefresh,
          assertCurrent,
        );
        const feedback = inboxCaptureCoordinator.createRecoveredFeedback(
          warning.requestGeneration,
          warning.activation,
          createdEntry,
          true,
        );
        assertCurrent();
        inboxCaptureFeedbackRef.current = feedback;
        setInboxCaptureSyncWarningState((current) => (current === warning ? null : current));
        setInboxCaptureFeedbackState({
          activation: warning.activation,
          feedback,
        });
      } catch (error) {
        if (
          error instanceof InboxCaptureSupersededError ||
          !inboxCaptureCoordinator.isSyncRefreshCurrent(intent, inboxCaptureActivationRef.current)
        ) {
          return;
        }
        throw inboxCaptureSyncRefreshError(error);
      }
    },
    [inboxCaptureCoordinator, prepareInboxSnapshotRefresh],
  );
  const createManualTask = useCallback(
    async (workspaceId: string, title: string, planning: TaskPlanning): Promise<void> => {
      const activation = taskCreateActivationRef.current;
      const intent = taskCreateCoordinator.beginCreate(activation);
      taskCreateFeedbackRef.current = null;
      setTaskCreateFeedbackState(null);
      try {
        if (activation.workspaceId !== workspaceId) throw new TaskCreateSupersededError();
        const commit = await taskController.create(title, planning);
        if (!taskCreateCoordinator.isCreateCurrent(intent, taskCreateActivationRef.current)) return;
        if (!commit.committed || commit.createdTask === null) {
          if (commit.reconciliationWarning) {
            setTaskCreateSyncWarningState({
              activation: intent.workspace,
              requestGeneration: intent.generation,
              title: commit.createdTask?.title ?? title,
              message: commit.reconciliationWarning,
            });
          }
          return;
        }
        const feedback = taskCreateCoordinator.createFeedback(
          intent,
          taskCreateActivationRef.current,
          commit.createdTask,
          true,
        );
        taskCreateFeedbackRef.current = feedback;
        setTaskCreateFeedbackState({
          activation: intent.workspace,
          feedback,
        });
      } catch (error) {
        if (
          !taskCreateCoordinator.isCreateCurrent(intent, taskCreateActivationRef.current) ||
          error instanceof TaskCreateSupersededError
        ) {
          return;
        }
        throw error;
      } finally {
        taskCreateCoordinator.endCreate(intent);
      }
    },
    [taskController, taskCreateCoordinator],
  );
  const openManualTask = useCallback(
    async (feedback: TaskCreateFeedback): Promise<void> => {
      searchNavigation.invalidate();
      automationOutputNavigation.invalidate();
      automationCreateCoordinator.cancelOpen();
      assistantSavedNoteNavigation.invalidate();
      inboxCaptureCoordinator.cancelOpen();
      inboxConversionNavigation.invalidate();
      try {
        const intent = taskCreateCoordinator.beginOpen(taskCreateActivationRef.current, feedback);
        const assertCurrent = () =>
          taskCreateCoordinator.assertOpenCurrent(
            intent,
            taskCreateActivationRef.current,
            taskCreateFeedbackRef.current,
          );
        const target = await resolveTaskCreateNavigationTarget(
          intent,
          taskController.prepareSnapshotRefresh,
          assertCurrent,
        );
        assertCurrent();
        if (!activeWorkspace || activeWorkspace.id !== target.workspaceId) {
          throw new TaskCreateSupersededError();
        }
        if (!confirmLeaveNoteDraft()) throw new TaskCreateNoteDraftPreservedError();
        assertCurrent();
        const discardConfirmedNoteDraft = noteDraftDirtyRef.current;
        if (
          !taskCreateCoordinator.dismiss(
            feedback,
            taskCreateActivationRef.current,
            taskCreateFeedbackRef.current,
          )
        ) {
          throw new TaskCreateSupersededError();
        }

        taskCreateFeedbackRef.current = null;
        setTaskCreateFeedbackState((current) => (current?.feedback === feedback ? null : current));
        if (discardConfirmedNoteDraft) {
          setNotePageGeneration((generation) => generation + 1);
        }
        setPaletteOpen(false);
        setAssistantSurfaceOpen(false);
        setRequestedNoteId(null);
        setInboxReveal(null);
        updatePreferences({ activeView: 'tasks' }, true, target.workspaceId);
        setTaskDialog({
          mode: 'rename',
          workspaceId: target.workspaceId,
          workspaceName: activeWorkspace.name,
          task: target.task,
        });
      } catch (error) {
        throw taskCreateNavigationError(error);
      }
    },
    [
      activeWorkspace,
      assistantSavedNoteNavigation,
      automationCreateCoordinator,
      automationOutputNavigation,
      confirmLeaveNoteDraft,
      inboxCaptureCoordinator,
      inboxConversionNavigation,
      searchNavigation,
      taskController.prepareSnapshotRefresh,
      taskCreateCoordinator,
      updatePreferences,
    ],
  );
  const dismissTaskCreate = useCallback(
    (feedback: TaskCreateFeedback): boolean => {
      if (
        !taskCreateCoordinator.dismiss(
          feedback,
          taskCreateActivationRef.current,
          taskCreateFeedbackRef.current,
        )
      ) {
        return false;
      }
      taskCreateFeedbackRef.current = null;
      setTaskCreateFeedbackState((current) => (current?.feedback === feedback ? null : current));
      return true;
    },
    [taskCreateCoordinator],
  );
  const restoreTaskCreateFocus = useCallback((): void => {
    const heading = document.querySelector<HTMLElement>('.section-page h1, .today-dashboard h1');
    heading?.focus({ preventScroll: true });
    if (document.activeElement === heading) return;
    document
      .querySelector<HTMLElement>(
        '.page-chrome__actions button:not(:disabled), .dashboard-hero__actions button:not(:disabled), .activity-rail button[aria-current="page"]',
      )
      ?.focus({ preventScroll: true });
  }, []);
  const dismissTaskCreateSyncWarning = useCallback(
    (requestGeneration: number): void => {
      setTaskCreateSyncWarningState((current) =>
        current?.requestGeneration === requestGeneration ? null : current,
      );
      window.requestAnimationFrame(restoreTaskCreateFocus);
    },
    [restoreTaskCreateFocus],
  );

  const openTaskCreate = useCallback(
    (planning: TaskPlanning) => {
      if (
        !activeWorkspace ||
        archiveManager.open ||
        (planning !== 'none' &&
          !taskController.snapshot?.planningDays.some(({ token }) => token === planning)) ||
        workspaceDialog !== null ||
        quickCaptureTarget !== null ||
        scheduleDialog !== null ||
        automationDialog !== null ||
        focusDialogOpen ||
        dataState.importPreview !== null ||
        workspaceController.pendingOperation !== null
      ) {
        return;
      }
      setPaletteOpen(false);
      setTaskDialog({
        mode: 'create',
        workspaceId: activeWorkspace.id,
        workspaceName: activeWorkspace.name,
        planning,
      });
    },
    [
      activeWorkspace,
      archiveManager.open,
      automationDialog,
      focusDialogOpen,
      quickCaptureTarget,
      scheduleDialog,
      taskController.snapshot,
      dataState.importPreview,
      workspaceController.pendingOperation,
      workspaceDialog,
    ],
  );

  const openScheduleCreate = useCallback(
    (expectedDate: string) => {
      if (
        !activeWorkspace ||
        archiveManager.open ||
        visibleScheduleMutationSyncWarning !== null ||
        !scheduleController.snapshot ||
        !scheduleController.snapshot.planningDays.some(({ date }) => date === expectedDate) ||
        workspaceDialog !== null ||
        quickCaptureTarget !== null ||
        taskDialog !== null ||
        scheduleDialog !== null ||
        automationDialog !== null ||
        focusDialogOpen ||
        dataState.importPreview !== null ||
        workspaceController.pendingOperation !== null
      ) {
        return;
      }
      const defaults = defaultScheduleRangeForPlanningDate(
        expectedDate,
        scheduleController.snapshot.todayDate,
        new Date(),
      );
      setPaletteOpen(false);
      setScheduleDialog({
        mode: 'create',
        workspaceId: activeWorkspace.id,
        workspaceName: activeWorkspace.name,
        expectedDate: defaults.expectedDate,
        startMinute: defaults.startMinute,
        endMinute: defaults.endMinute,
      });
    },
    [
      activeWorkspace,
      archiveManager.open,
      automationDialog,
      quickCaptureTarget,
      scheduleController.snapshot,
      scheduleDialog,
      dataState.importPreview,
      focusDialogOpen,
      taskDialog,
      workspaceController.pendingOperation,
      workspaceDialog,
      visibleScheduleMutationSyncWarning,
    ],
  );
  const openScheduleEdit = useCallback(
    (item: ScheduleItem): void => {
      const activation = scheduleMutationActivationRef.current;
      if (
        !activeWorkspace ||
        scheduleMutationCoordinator.isPending(activation.workspaceId) ||
        scheduleWriteIsBlocked(activation)
      ) {
        return;
      }
      setScheduleDialog({
        mode: 'edit',
        workspaceId: activeWorkspace.id,
        workspaceName: activeWorkspace.name,
        expectedDate: item.scheduledFor,
        item,
      });
    },
    [activeWorkspace, scheduleMutationCoordinator, scheduleWriteIsBlocked],
  );

  const createManualSchedule = useCallback(
    async (
      workspaceId: string,
      expectedDate: string,
      title: string,
      kind: ScheduleKind,
      startMinute: number,
      endMinute: number,
    ): Promise<void> => {
      const mutationActivation = scheduleMutationActivationRef.current;
      if (scheduleWriteIsBlocked(mutationActivation)) {
        throw new Error('请先重新读取上一项已提交的日程写入，再继续创建日程。');
      }
      const mutationIntent = scheduleMutationCoordinator.begin(mutationActivation, 'create');
      if (mutationIntent === null) {
        throw new Error('这个工作区正在处理另一项日程写入。');
      }
      try {
        const activation = scheduleCreateActivationRef.current;
        const intent = scheduleCreateCoordinator.beginCreate(activation);
        scheduleCreatePublicationGate.clear();
        scheduleCreateFeedbackRef.current = null;
        setScheduleCreateFeedbackState(null);
        setScheduleCreateSyncWarningState(null);
        try {
          if (activation.workspaceId !== workspaceId) {
            throw new ScheduleCreateSupersededError();
          }
          const commit = await scheduleController.create(
            expectedDate,
            title,
            kind,
            startMinute,
            endMinute,
          );
          if (
            !scheduleCreateCoordinator.isCreateCurrent(intent, scheduleCreateActivationRef.current)
          ) {
            return;
          }
          if (
            !commit.committed ||
            commit.createdSchedule === null ||
            commit.committedTodayDate === null
          ) {
            if (commit.reconciliationWarning) {
              scheduleCreatePublicationGate.stage(intent.workspace, {
                kind: 'warning',
                warning: {
                  activation: intent.workspace,
                  requestGeneration: intent.generation,
                  createdScheduleId: commit.result.createdScheduleId,
                  title: commit.createdSchedule?.title ?? title,
                  scheduledFor: commit.createdSchedule?.scheduledFor ?? expectedDate,
                  startMinute: commit.createdSchedule?.startMinute ?? startMinute,
                  endMinute: commit.createdSchedule?.endMinute ?? endMinute,
                  message: commit.reconciliationWarning,
                },
              });
            }
            return;
          }
          const feedback = scheduleCreateCoordinator.createFeedback(
            intent,
            scheduleCreateActivationRef.current,
            commit.createdSchedule,
            true,
          );
          scheduleCreatePublicationGate.stage(intent.workspace, {
            kind: 'feedback',
            activation: intent.workspace,
            feedback,
            todayDate: commit.committedTodayDate,
          });
        } catch (error) {
          if (
            !scheduleCreateCoordinator.isCreateCurrent(
              intent,
              scheduleCreateActivationRef.current,
            ) ||
            error instanceof ScheduleCreateSupersededError
          ) {
            return;
          }
          throw error;
        } finally {
          scheduleCreateCoordinator.endCreate(intent);
        }
      } finally {
        scheduleMutationCoordinator.end(mutationIntent);
      }
    },
    [
      scheduleController,
      scheduleCreateCoordinator,
      scheduleCreatePublicationGate,
      scheduleMutationCoordinator,
      scheduleWriteIsBlocked,
    ],
  );

  const openCreatedSchedule = useCallback(
    async (feedback: ScheduleCreateFeedback): Promise<void> => {
      const mutationActivation = scheduleMutationActivationRef.current;
      if (scheduleWriteIsBlocked(mutationActivation)) {
        throw new Error('请先完成当前日程写入的重新读取，再编辑刚创建的日程。');
      }
      const mutationIntent = scheduleMutationCoordinator.begin(mutationActivation, 'recover');
      if (mutationIntent === null) {
        throw new Error('这个工作区正在处理另一项日程写入。');
      }
      scheduleNavigationIntentRef.current = mutationIntent;
      setScheduleNavigationPending(true);
      try {
        searchNavigation.invalidate();
        automationOutputNavigation.invalidate();
        automationCreateCoordinator.cancelOpen();
        assistantSavedNoteNavigation.invalidate();
        inboxCaptureCoordinator.cancelOpen();
        taskCreateCoordinator.cancelOpen();
        inboxConversionNavigation.invalidate();
        const intent = scheduleCreateCoordinator.beginOpen(
          scheduleCreateActivationRef.current,
          feedback,
        );
        const assertCurrent = () =>
          scheduleCreateCoordinator.assertOpenCurrent(
            intent,
            scheduleCreateActivationRef.current,
            scheduleCreateFeedbackRef.current,
          );
        const target = await resolveScheduleCreateNavigationTarget(
          intent,
          scheduleController.prepareSnapshotRefresh,
          assertCurrent,
        );
        assertCurrent();
        if (!activeWorkspace || activeWorkspace.id !== target.workspaceId) {
          throw new ScheduleCreateSupersededError();
        }
        if (!confirmLeaveNoteDraft()) {
          throw new ScheduleCreateNoteDraftPreservedError();
        }
        assertCurrent();
        if (!isScheduleCreateTodayDateCurrent(target.todayDate, new Date())) {
          throw new ScheduleCreateUnavailableError();
        }
        const discardConfirmedNoteDraft = noteDraftDirtyRef.current;
        focusTodayActivityRailAnchor();
        if (
          !scheduleCreateCoordinator.dismiss(
            feedback,
            scheduleCreateActivationRef.current,
            scheduleCreateFeedbackRef.current,
          )
        ) {
          throw new ScheduleCreateSupersededError();
        }

        scheduleCreateFeedbackRef.current = null;
        setScheduleCreateFeedbackState((current) =>
          current?.feedback === feedback ? null : current,
        );
        if (discardConfirmedNoteDraft) {
          setNotePageGeneration((generation) => generation + 1);
        }
        setPaletteOpen(false);
        setAssistantSurfaceOpen(false);
        setRequestedNoteId(null);
        setInboxReveal(null);
        updatePreferences({ activeView: 'today' }, true, target.workspaceId);
        setScheduleDialog({
          mode: 'edit',
          workspaceId: target.workspaceId,
          workspaceName: activeWorkspace.name,
          expectedDate: target.item.scheduledFor,
          item: target.item,
        });
      } catch (error) {
        throw scheduleCreateNavigationError(error);
      } finally {
        scheduleMutationCoordinator.end(mutationIntent);
        if (scheduleNavigationIntentRef.current === mutationIntent) {
          scheduleNavigationIntentRef.current = null;
          setScheduleNavigationPending(false);
        }
      }
    },
    [
      activeWorkspace,
      assistantSavedNoteNavigation,
      automationCreateCoordinator,
      automationOutputNavigation,
      confirmLeaveNoteDraft,
      inboxCaptureCoordinator,
      inboxConversionNavigation,
      scheduleController.prepareSnapshotRefresh,
      scheduleCreateCoordinator,
      scheduleMutationCoordinator,
      scheduleWriteIsBlocked,
      searchNavigation,
      taskCreateCoordinator,
      updatePreferences,
    ],
  );

  const dismissScheduleCreate = useCallback(
    (feedback: ScheduleCreateFeedback): boolean => {
      if (
        !scheduleCreateCoordinator.dismiss(
          feedback,
          scheduleCreateActivationRef.current,
          scheduleCreateFeedbackRef.current,
        )
      ) {
        return false;
      }
      scheduleCreateFeedbackRef.current = null;
      setScheduleCreateFeedbackState((current) =>
        current?.feedback === feedback ? null : current,
      );
      return true;
    },
    [scheduleCreateCoordinator],
  );

  const restoreScheduleCreateFocus = useCallback((): void => {
    const heading = document.querySelector<HTMLElement>('.today-dashboard h1, .section-page h1');
    heading?.focus({ preventScroll: true });
    if (document.activeElement === heading) return;
    document
      .querySelector<HTMLElement>(
        '.dashboard-hero__actions button:not(:disabled), .page-chrome__actions button:not(:disabled), .activity-rail button[aria-current="page"]',
      )
      ?.focus({ preventScroll: true });
  }, []);

  const dismissScheduleCreateSyncWarning = useCallback(
    (warning: ScheduleCreateSyncWarningState): void => {
      if (
        !scheduleCreateCoordinator.isGenerationCurrent(
          warning.requestGeneration,
          warning.activation,
        )
      ) {
        return;
      }
      invalidateScheduleCreate();
      window.requestAnimationFrame(restoreScheduleCreateFocus);
    },
    [invalidateScheduleCreate, restoreScheduleCreateFocus, scheduleCreateCoordinator],
  );

  const refreshScheduleCreateSyncWarning = useCallback(
    async (warning: ScheduleCreateSyncWarningState): Promise<void> => {
      const mutationActivation = scheduleMutationActivationRef.current;
      if (scheduleWriteIsBlocked(mutationActivation)) {
        throw new ScheduleCreateSyncRefreshError(
          '请先完成当前日程写入的重新读取，再确认刚创建的日程。',
        );
      }
      const mutationIntent = scheduleMutationCoordinator.begin(mutationActivation, 'recover');
      if (mutationIntent === null) {
        throw new ScheduleCreateSyncRefreshError('这个工作区正在处理另一项日程写入。');
      }
      scheduleNavigationIntentRef.current = mutationIntent;
      setScheduleNavigationPending(true);
      try {
        if (
          warning.activation !== scheduleCreateActivationRef.current ||
          !scheduleCreateCoordinator.isGenerationCurrent(
            warning.requestGeneration,
            warning.activation,
          )
        ) {
          throw new ScheduleCreateSupersededError();
        }
        const refresh = await scheduleController.prepareSnapshotRefresh();
        if (
          warning.activation !== scheduleCreateActivationRef.current ||
          refresh.snapshot.workspaceId !== warning.activation.workspaceId ||
          !scheduleCreateCoordinator.isGenerationCurrent(
            warning.requestGeneration,
            warning.activation,
          )
        ) {
          throw new ScheduleCreateSupersededError();
        }
        const matches = refresh.snapshot.items.filter(
          ({ id, scheduledFor }) =>
            id === warning.createdScheduleId && scheduledFor === warning.scheduledFor,
        );
        if (matches.length !== 1) {
          throw new ScheduleCreateSyncRefreshError(
            '重新读取后仍无法确认刚创建的日程。请稍后再试；日程可能已经创建，请不要重复创建。',
          );
        }
        if (!refresh.commit()) {
          throw new ScheduleCreateSyncRefreshError(
            '日程列表在读取期间发生变化。请重新读取；日程可能已经创建，请不要重复创建。',
          );
        }
        const feedback = scheduleCreateCoordinator.createRecoveredFeedback(
          warning.requestGeneration,
          warning.activation,
          matches[0]!,
          true,
        );
        scheduleCreateFeedbackRef.current = feedback;
        setScheduleCreateSyncWarningState((current) => (current === warning ? null : current));
        setScheduleCreateFeedbackState({
          activation: warning.activation,
          feedback,
        });
      } catch (error) {
        throw scheduleCreateSyncRefreshError(error);
      } finally {
        scheduleMutationCoordinator.end(mutationIntent);
        if (scheduleNavigationIntentRef.current === mutationIntent) {
          scheduleNavigationIntentRef.current = null;
          setScheduleNavigationPending(false);
        }
      }
    },
    [
      scheduleController,
      scheduleCreateCoordinator,
      scheduleMutationCoordinator,
      scheduleWriteIsBlocked,
    ],
  );

  const createManualAutomation = useCallback(
    async (
      workspaceId: string,
      name: string,
      schedule: AutomationSchedule,
      action: AutomationAction,
    ): Promise<void> => {
      const activation = automationCreateActivationRef.current;
      const intent = automationCreateCoordinator.beginCreate(activation);
      automationCreateFeedbackRef.current = null;
      setAutomationCreateFeedbackState(null);
      setAutomationCreateSyncWarningState(null);
      try {
        if (activation.workspaceId !== workspaceId) {
          throw new AutomationCreateSupersededError();
        }
        const commit = await automationController.create(name, schedule, action);
        if (
          !automationCreateCoordinator.isCreateCurrent(
            intent,
            automationCreateActivationRef.current,
          )
        ) {
          return;
        }
        if (!commit.committed || commit.createdAutomation === null) {
          if (commit.reconciliationWarning) {
            setAutomationCreateSyncWarningState({
              activation: intent.workspace,
              requestGeneration: intent.generation,
              createdAutomationId: commit.result.createdAutomationId,
              name: commit.createdAutomation?.name ?? name,
              enabled: commit.createdAutomation?.enabled ?? false,
              message: commit.reconciliationWarning,
            });
          }
          return;
        }
        const feedback = automationCreateCoordinator.createFeedback(
          intent,
          automationCreateActivationRef.current,
          commit.createdAutomation,
          true,
        );
        automationCreateFeedbackRef.current = feedback;
        setAutomationCreateFeedbackState({
          activation: intent.workspace,
          feedback,
        });
      } catch (error) {
        if (
          !automationCreateCoordinator.isCreateCurrent(
            intent,
            automationCreateActivationRef.current,
          ) ||
          error instanceof AutomationCreateSupersededError
        ) {
          return;
        }
        throw error;
      } finally {
        automationCreateCoordinator.endCreate(intent);
      }
    },
    [automationController, automationCreateCoordinator],
  );

  const openCreatedAutomation = useCallback(
    async (feedback: AutomationCreateFeedback): Promise<void> => {
      searchNavigation.invalidate();
      automationOutputNavigation.invalidate();
      assistantSavedNoteNavigation.invalidate();
      inboxCaptureCoordinator.cancelOpen();
      taskCreateCoordinator.cancelOpen();
      inboxConversionNavigation.invalidate();
      try {
        const intent = automationCreateCoordinator.beginOpen(
          automationCreateActivationRef.current,
          feedback,
        );
        const assertCurrent = () =>
          automationCreateCoordinator.assertOpenCurrent(
            intent,
            automationCreateActivationRef.current,
            automationCreateFeedbackRef.current,
          );
        const target = await resolveAutomationCreateNavigationTarget(
          intent,
          automationController.prepareSnapshotRefresh,
          assertCurrent,
        );
        assertCurrent();
        if (!activeWorkspace || activeWorkspace.id !== target.workspaceId) {
          throw new AutomationCreateSupersededError();
        }
        if (!confirmLeaveNoteDraft()) {
          throw new AutomationCreateNoteDraftPreservedError();
        }
        assertCurrent();
        const discardConfirmedNoteDraft = noteDraftDirtyRef.current;
        focusAutomationActivityRailAnchor();
        if (
          !automationCreateCoordinator.dismiss(
            feedback,
            automationCreateActivationRef.current,
            automationCreateFeedbackRef.current,
          )
        ) {
          throw new AutomationCreateSupersededError();
        }

        automationCreateFeedbackRef.current = null;
        setAutomationCreateFeedbackState((current) =>
          current?.feedback === feedback ? null : current,
        );
        if (discardConfirmedNoteDraft) {
          setNotePageGeneration((generation) => generation + 1);
        }
        setPaletteOpen(false);
        setAssistantSurfaceOpen(false);
        setRequestedNoteId(null);
        setInboxReveal(null);
        updatePreferences({ activeView: 'automations' }, true, target.workspaceId);
        setAutomationDialog({
          mode: 'edit',
          workspaceId: target.workspaceId,
          workspaceName: activeWorkspace.name,
          item: target.item,
        });
      } catch (error) {
        throw automationCreateNavigationError(error);
      }
    },
    [
      activeWorkspace,
      assistantSavedNoteNavigation,
      automationController.prepareSnapshotRefresh,
      automationCreateCoordinator,
      automationOutputNavigation,
      confirmLeaveNoteDraft,
      inboxCaptureCoordinator,
      inboxConversionNavigation,
      searchNavigation,
      taskCreateCoordinator,
      updatePreferences,
    ],
  );

  const dismissAutomationCreate = useCallback(
    (feedback: AutomationCreateFeedback): boolean => {
      if (
        !automationCreateCoordinator.dismiss(
          feedback,
          automationCreateActivationRef.current,
          automationCreateFeedbackRef.current,
        )
      ) {
        return false;
      }
      automationCreateFeedbackRef.current = null;
      setAutomationCreateFeedbackState((current) =>
        current?.feedback === feedback ? null : current,
      );
      return true;
    },
    [automationCreateCoordinator],
  );

  const restoreAutomationCreateFocus = useCallback((): void => {
    const heading = document.querySelector<HTMLElement>('.section-page h1, .today-dashboard h1');
    heading?.focus({ preventScroll: true });
    if (document.activeElement === heading) return;
    document
      .querySelector<HTMLElement>(
        '.page-chrome__actions button:not(:disabled), .dashboard-hero__actions button:not(:disabled), .activity-rail button[aria-current="page"]',
      )
      ?.focus({ preventScroll: true });
  }, []);

  const dismissAutomationCreateSyncWarning = useCallback(
    (warning: AutomationCreateSyncWarningState): void => {
      if (
        !automationCreateCoordinator.isGenerationCurrent(
          warning.requestGeneration,
          warning.activation,
        )
      ) {
        return;
      }
      invalidateAutomationCreate();
      window.requestAnimationFrame(restoreAutomationCreateFocus);
    },
    [automationCreateCoordinator, invalidateAutomationCreate, restoreAutomationCreateFocus],
  );

  const refreshAutomationCreateSyncWarning = useCallback(
    async (warning: AutomationCreateSyncWarningState): Promise<void> => {
      try {
        if (
          warning.activation !== automationCreateActivationRef.current ||
          !automationCreateCoordinator.isGenerationCurrent(
            warning.requestGeneration,
            warning.activation,
          )
        ) {
          throw new AutomationCreateSupersededError();
        }
        const refresh = await automationController.prepareSnapshotRefresh();
        if (
          warning.activation !== automationCreateActivationRef.current ||
          refresh.snapshot.workspaceId !== warning.activation.workspaceId ||
          !automationCreateCoordinator.isGenerationCurrent(
            warning.requestGeneration,
            warning.activation,
          )
        ) {
          throw new AutomationCreateSupersededError();
        }
        const matches = refresh.snapshot.items.filter(
          ({ id }) => id === warning.createdAutomationId,
        );
        if (matches.length !== 1) {
          throw new AutomationCreateSyncRefreshError(
            '重新读取后仍无法确认刚创建的自动化。请稍后再试；规则可能已经创建，请不要重复创建。',
          );
        }
        if (!refresh.commit()) {
          throw new AutomationCreateSyncRefreshError(
            '自动化列表在读取期间发生变化。请重新读取；规则可能已经创建，请不要重复创建。',
          );
        }
        const feedback = automationCreateCoordinator.createRecoveredFeedback(
          warning.requestGeneration,
          warning.activation,
          matches[0]!,
          true,
        );
        automationCreateFeedbackRef.current = feedback;
        setAutomationCreateSyncWarningState((current) => (current === warning ? null : current));
        setAutomationCreateFeedbackState({
          activation: warning.activation,
          feedback,
        });
      } catch (error) {
        throw automationCreateSyncRefreshError(error);
      }
    },
    [automationController, automationCreateCoordinator],
  );

  const openAutomationCreate = useCallback(() => {
    if (
      !activeWorkspace ||
      archiveManager.open ||
      workspaceDialog !== null ||
      quickCaptureTarget !== null ||
      taskDialog !== null ||
      scheduleDialog !== null ||
      automationDialog !== null ||
      focusDialogOpen ||
      dataState.importPreview !== null ||
      workspaceController.pendingOperation !== null
    ) {
      return;
    }
    setPaletteOpen(false);
    setAutomationDialog({
      mode: 'create',
      workspaceId: activeWorkspace.id,
      workspaceName: activeWorkspace.name,
    });
  }, [
    activeWorkspace,
    archiveManager.open,
    automationDialog,
    dataState.importPreview,
    focusDialogOpen,
    quickCaptureTarget,
    scheduleDialog,
    taskDialog,
    workspaceController.pendingOperation,
    workspaceDialog,
  ]);

  const openAutomationEdit = useCallback(
    (item: AutomationItem) => {
      if (
        !activeWorkspace ||
        archiveManager.open ||
        workspaceDialog !== null ||
        quickCaptureTarget !== null ||
        taskDialog !== null ||
        scheduleDialog !== null ||
        automationDialog !== null ||
        focusDialogOpen ||
        dataState.importPreview !== null ||
        workspaceController.pendingOperation !== null
      ) {
        return;
      }
      setPaletteOpen(false);
      setAutomationDialog({
        mode: 'edit',
        workspaceId: activeWorkspace.id,
        workspaceName: activeWorkspace.name,
        item,
      });
    },
    [
      activeWorkspace,
      archiveManager.open,
      automationDialog,
      dataState.importPreview,
      focusDialogOpen,
      quickCaptureTarget,
      scheduleDialog,
      taskDialog,
      workspaceController.pendingOperation,
      workspaceDialog,
    ],
  );

  const openFocusDialog = useCallback(
    (taskId?: string) => {
      if (
        !activeWorkspace ||
        archiveManager.open ||
        workspaceDialog !== null ||
        quickCaptureTarget !== null ||
        taskDialog !== null ||
        scheduleDialog !== null ||
        automationDialog !== null ||
        focusDialogOpen ||
        dataState.importPreview !== null ||
        workspaceController.pendingOperation !== null ||
        focusStartBlockReason !== null
      ) {
        return;
      }

      let initialTask: FocusDialogState['initialTask'] = null;
      if (taskId !== undefined) {
        const task = taskController.snapshot?.tasks.find(({ id }) => id === taskId);
        if (
          taskFocusStartBlockReason !== null ||
          !task ||
          !isTaskEligibleForFocus(task, taskController.snapshot)
        ) {
          return;
        }
        initialTask = { id: task.id, title: task.title };
      }

      setPaletteOpen(false);
      setFocusDialog({
        id: ++focusDialogSequenceRef.current,
        activation: focusActivation,
        initialTask,
      });
    },
    [
      activeWorkspace,
      archiveManager.open,
      automationDialog,
      dataState.importPreview,
      focusActivation,
      focusDialogOpen,
      focusStartBlockReason,
      quickCaptureTarget,
      scheduleDialog,
      taskController.snapshot,
      taskDialog,
      taskFocusStartBlockReason,
      workspaceController.pendingOperation,
      workspaceDialog,
    ],
  );

  const completeFocusTask = useCallback(
    async (notice: FocusTaskCompletionNotice): Promise<void> => {
      if (!focusTaskCompletionGate.begin(notice.key)) {
        throw new FocusTaskCompletionSupersededError();
      }
      setFocusTaskCompletionAction(focusTaskCompletionStarted(notice.key));
      try {
        const intent = focusTaskCompletionCoordinator.begin(
          focusTaskCompletionActivationRef.current,
          notice,
        );
        const assertCurrent = () =>
          focusTaskCompletionCoordinator.assertCurrent(
            intent,
            focusTaskCompletionActivationRef.current,
            focusTaskCompletionSurfaceRef.current,
            focusTaskCompletionNoticeRef.current,
          );
        const target = await resolveFocusTaskCompletionTarget(
          intent,
          taskController.prepareSnapshotRefresh,
          assertCurrent,
        );
        assertCurrent();
        if (!target.alreadyCompleted) {
          if (taskController.isPending(target.task.id)) {
            throw new Error('这项任务正在进行另一项更新，请稍候再试。');
          }
          await taskController.updateStatus(target.task.id, 'completed');
          assertCurrent();
        }
        setFocusTaskCompletionAction((current) => focusTaskCompletionFinished(current, notice.key));
      } catch (error) {
        const failure = focusTaskCompletionError(error);
        setFocusTaskCompletionAction((current) =>
          failure instanceof FocusTaskCompletionSupersededError
            ? focusTaskCompletionFinished(current, notice.key)
            : focusTaskCompletionFailed(current, notice.key, failure.message),
        );
        throw failure;
      } finally {
        focusTaskCompletionGate.end(notice.key);
      }
    },
    [focusTaskCompletionCoordinator, focusTaskCompletionGate, taskController],
  );

  const dismissFocusTaskCompletion = useCallback(
    (notice: FocusTaskCompletionNotice): void => {
      if (focusTaskCompletionNoticeRef.current?.key !== notice.key) return;
      focusTaskCompletionCoordinator.invalidate();
      setFocusTaskCompletionAction((current) =>
        current?.completionKey === notice.key ? null : current,
      );
      setDismissedFocusTaskCompletions((current) => {
        if (current.has(notice.key)) return current;
        const next = new Set(current);
        next.add(notice.key);
        return next;
      });
    },
    [focusTaskCompletionCoordinator],
  );

  const rememberAssistantSavedNote = useCallback((target: AssistantSavedNoteTarget): void => {
    const next = new Map(assistantSavedNotesRef.current);
    next.delete(target.responseKey);
    next.set(target.responseKey, target);
    while (next.size > ASSISTANT_SAVED_NOTE_TARGET_LIMIT) {
      const oldestKey = next.keys().next().value;
      if (oldestKey === undefined) break;
      next.delete(oldestKey);
    }
    assistantSavedNotesRef.current = next;
    setAssistantSavedNotes(next);
  }, []);

  const startAssistantRequest = useCallback(
    async (prompt: string, context: AssistantContextReference): Promise<void> => {
      assistantSavedNoteNavigation.invalidate();
      await startAssistant(prompt, context);
    },
    [assistantSavedNoteNavigation, startAssistant],
  );

  const saveAssistantResponse = useCallback(
    async (responseKey: string, response: string): Promise<AssistantSavedNoteTarget> => {
      const existing = assistantSavedNotesRef.current.get(responseKey);
      if (existing) return existing;
      const activation = assistantSavedNoteActivationRef.current;
      if (
        activation.workspaceId === null ||
        assistantResponseKeyRef.current !== responseKey ||
        currentSurfaceRef.current !== 'assistant'
      ) {
        throw new AssistantSavedNoteSupersededError();
      }
      const noteActivation = noteCreateActivationRef.current;
      if (
        noteActivation.workspaceId !== activation.workspaceId ||
        noteWriteIsBlocked(noteActivation) ||
        noteMutationCoordinator.isPending(noteActivation.workspaceId)
      ) {
        throw new Error('这个工作区正在处理或确认另一项笔记写入，请稍候。');
      }
      if (!assistantSavedNoteSaveGate.begin(responseKey)) {
        throw new Error('这个回答正在保存，请稍候。');
      }
      try {
        const noteTitle = `AI 助手回复 · ${new Intl.DateTimeFormat('zh-CN').format(new Date())}`;
        const commit = await createNote(noteTitle, response);
        const target: AssistantSavedNoteTarget = {
          responseKey,
          workspaceId: activation.workspaceId,
          noteId: commit.result.createdNoteId,
          noteTitle: commit.createdNote?.title ?? noteTitle,
        };
        rememberAssistantSavedNote(target);
        return target;
      } finally {
        assistantSavedNoteSaveGate.end(responseKey);
      }
    },
    [
      assistantSavedNoteSaveGate,
      createNote,
      noteMutationCoordinator,
      noteWriteIsBlocked,
      rememberAssistantSavedNote,
    ],
  );

  const openAssistantSavedNote = useCallback(
    async (target: AssistantSavedNoteTarget): Promise<void> => {
      assertNoteOutputNavigationAvailable(target.workspaceId);
      automationCreateCoordinator.cancelOpen();
      taskCreateCoordinator.cancelOpen();
      try {
        const intent = assistantSavedNoteNavigation.begin(
          assistantSavedNoteActivationRef.current,
          target,
        );
        const assertCurrent = () =>
          assistantSavedNoteNavigation.assertCurrent(
            intent,
            assistantSavedNoteActivationRef.current,
            currentSurfaceRef.current,
            assistantResponseKeyRef.current,
            assistantSavedNoteTargetRef.current,
          );
        const resolved = await resolveAssistantSavedNoteNavigationTarget(
          intent,
          prepareNoteSnapshotRefresh,
          assertCurrent,
        );
        assertCurrent();
        setPaletteOpen(false);
        setAssistantSurfaceOpen(false);
        setInboxReveal(null);
        updatePreferences({ activeView: 'notes' }, true, resolved.workspaceId);
        setRequestedNoteId(resolved.note.id);
      } catch (error) {
        throw assistantSavedNoteNavigationError(error);
      }
    },
    [
      assistantSavedNoteNavigation,
      assertNoteOutputNavigationAvailable,
      automationCreateCoordinator,
      prepareNoteSnapshotRefresh,
      taskCreateCoordinator,
      updatePreferences,
    ],
  );

  const convertInboxToTask = useCallback(
    async (entry: InboxEntry, planning: TaskPlanning): Promise<void> => {
      inboxConversionNavigation.invalidate();
      if (inboxConversionSyncWarningRef.current !== null) {
        throw new Error('请先重新读取上一条已转换记录，再继续处理收件箱。');
      }
      inboxConversionPublicationGate.clear();
      const intent = inboxConversionRequestCoordinator.begin(
        inboxConversionActivationRef.current,
        entry.id,
        'task',
      );
      if (!intent) return;
      setPendingInboxConversionIntents((current) => {
        const workspaceId = intent.workspace.workspaceId!;
        const next = new Map(current);
        next.set(workspaceId, intent);
        return next;
      });
      inboxController.clearOperationError();
      taskController.clearOperationError();
      noteController.clearOperationError();
      const inboxRequest = inboxController.reserveSnapshotRequest(intent.workspace.workspaceId!);
      if (!inboxRequest) {
        finishInboxConversionRequest(intent);
        return;
      }
      const failureIsCurrent = () =>
        inboxConversionRequestCoordinator.isCurrent(intent, inboxConversionActivationRef.current);
      try {
        const conversion = await taskController.convertInbox(entry.id, planning, failureIsCurrent);
        const workspaceId = intent.workspace.workspaceId!;
        const inboxCommitted =
          isInboxConversionSourceArchived(workspaceId, entry.id, conversion.result.inboxSnapshot) &&
          inboxController.applyReservedSnapshot(conversion.result.inboxSnapshot, inboxRequest);
        const reconciliation = await reconcileInboxConversionSnapshots({
          initialOutputCommitted: conversion.committed,
          initialInboxCommitted: inboxCommitted,
          getCommittedOutput: () =>
            taskController.getCommittedConvertedTask(
              workspaceId,
              entry.id,
              conversion.result.createdTaskId,
            ),
          getCommittedInbox: () =>
            inboxController.isCommittedConversionSourceArchived(workspaceId, entry.id),
          prepareOutputSnapshotRefresh: taskController.prepareSnapshotRefresh,
          prepareInboxSnapshotRefresh: inboxController.prepareSnapshotRefresh,
          outputFromSnapshot: (snapshot) =>
            convertedTaskFromSnapshot(
              workspaceId,
              entry.id,
              conversion.result.createdTaskId,
              snapshot,
            ),
          inboxSnapshotIsCommitted: (snapshot) =>
            isInboxConversionSourceArchived(workspaceId, entry.id, snapshot),
          isCurrent: failureIsCurrent,
        });
        if (!failureIsCurrent()) return;
        const output = reconciliation.output ?? conversion.createdTask;
        const feedback = inboxConversionRequestCoordinator.createFeedback(
          intent,
          inboxConversionActivationRef.current,
          {
            outputId: conversion.result.createdTaskId,
            outputTitle: output?.title ?? entry.content,
          },
        );
        const publication: InboxConversionPublication =
          reconciliation.committed && output !== null
            ? {
                kind: 'feedback',
                activation: intent.workspace,
                feedback,
              }
            : {
                kind: 'warning',
                warning: {
                  activation: intent.workspace,
                  feedback,
                  focusActionOnMount: true,
                  message: '任务已经创建、来源也已经归档，但当前任务或收件箱列表未能安全同步。',
                },
              };
        inboxConversionPublicationGate.stage(intent.workspace, publication);
      } catch (error) {
        if (!failureIsCurrent() || error instanceof InboxConversionSupersededError) return;
        throw error;
      } finally {
        finishInboxConversionRequest(intent);
      }
    },
    [
      inboxController,
      inboxConversionNavigation,
      inboxConversionPublicationGate,
      inboxConversionRequestCoordinator,
      finishInboxConversionRequest,
      noteController,
      taskController,
    ],
  );

  const convertInboxToNote = useCallback(
    async (entry: InboxEntry): Promise<void> => {
      inboxConversionNavigation.invalidate();
      if (inboxConversionSyncWarningRef.current !== null) {
        throw new Error('请先重新读取上一条已转换记录，再继续处理收件箱。');
      }
      const noteActivation = noteCreateActivationRef.current;
      if (noteWriteIsBlocked(noteActivation)) {
        throw new Error('请先重新读取上一项已提交的笔记写入，再继续转换收件箱。');
      }
      const noteMutationIntent = noteMutationCoordinator.begin(
        noteActivation,
        'inbox-note-convert',
      );
      if (noteMutationIntent === null) {
        throw new Error('这个工作区正在处理另一项笔记写入。');
      }
      const intent = inboxConversionRequestCoordinator.begin(
        inboxConversionActivationRef.current,
        entry.id,
        'note',
      );
      if (!intent) {
        noteMutationCoordinator.end(noteMutationIntent);
        return;
      }
      setPendingInboxConversionIntents((current) => {
        const workspaceId = intent.workspace.workspaceId!;
        const next = new Map(current);
        next.set(workspaceId, intent);
        return next;
      });
      inboxController.clearOperationError();
      taskController.clearOperationError();
      noteController.clearOperationError();
      const inboxRequest = inboxController.reserveSnapshotRequest(intent.workspace.workspaceId!);
      if (!inboxRequest) {
        finishInboxConversionRequest(intent);
        noteMutationCoordinator.end(noteMutationIntent);
        return;
      }
      const failureIsCurrent = () =>
        inboxConversionRequestCoordinator.isCurrent(intent, inboxConversionActivationRef.current) &&
        noteMutationCoordinator.isCurrent(noteMutationIntent, noteCreateActivationRef.current);
      try {
        const conversion = await noteController.convertInbox(entry.id, failureIsCurrent);
        const workspaceId = intent.workspace.workspaceId!;
        const inboxCommitted =
          isInboxConversionSourceArchived(workspaceId, entry.id, conversion.result.inboxSnapshot) &&
          inboxController.applyReservedSnapshot(conversion.result.inboxSnapshot, inboxRequest);
        const reconciliation = await reconcileInboxConversionSnapshots({
          initialOutputCommitted: conversion.committed,
          initialInboxCommitted: inboxCommitted,
          getCommittedOutput: () =>
            noteController.getCommittedConvertedNote(
              workspaceId,
              entry.id,
              conversion.result.createdNoteId,
            ),
          getCommittedInbox: () =>
            inboxController.isCommittedConversionSourceArchived(workspaceId, entry.id),
          prepareOutputSnapshotRefresh: noteController.prepareSnapshotRefresh,
          prepareInboxSnapshotRefresh: inboxController.prepareSnapshotRefresh,
          outputFromSnapshot: (snapshot) =>
            convertedNoteFromSnapshot(
              workspaceId,
              entry.id,
              conversion.result.createdNoteId,
              snapshot,
            ),
          inboxSnapshotIsCommitted: (snapshot) =>
            isInboxConversionSourceArchived(workspaceId, entry.id, snapshot),
          isCurrent: failureIsCurrent,
        });
        if (!failureIsCurrent()) return;
        const output = reconciliation.output ?? conversion.createdNote;
        const feedback = inboxConversionRequestCoordinator.createFeedback(
          intent,
          inboxConversionActivationRef.current,
          {
            outputId: conversion.result.createdNoteId,
            outputTitle: output?.title ?? entry.content,
          },
        );
        publishInboxConversionPublication(
          reconciliation.committed && output !== null
            ? {
                kind: 'feedback',
                activation: intent.workspace,
                feedback,
              }
            : {
                kind: 'warning',
                warning: {
                  activation: intent.workspace,
                  feedback,
                  focusActionOnMount: false,
                  message: '笔记已经创建、来源也已经归档，但当前笔记或收件箱列表未能安全同步。',
                },
              },
        );
      } catch (error) {
        if (!failureIsCurrent() || error instanceof InboxConversionSupersededError) return;
        throw error;
      } finally {
        finishInboxConversionRequest(intent);
        noteMutationCoordinator.end(noteMutationIntent);
      }
    },
    [
      inboxController,
      inboxConversionNavigation,
      inboxConversionRequestCoordinator,
      finishInboxConversionRequest,
      noteController,
      noteMutationCoordinator,
      noteWriteIsBlocked,
      publishInboxConversionPublication,
      taskController,
    ],
  );

  const refreshInboxConversionSyncWarning = useCallback(
    async (warning: InboxConversionSyncWarningState): Promise<void> => {
      const { feedback } = warning;
      const warningIsCurrent = () =>
        warning.activation === inboxConversionActivationRef.current &&
        warning === inboxConversionSyncWarningRef.current &&
        inboxConversionRequestCoordinator.isGenerationCurrent(
          feedback.requestGeneration,
          warning.activation,
        );
      if (!warningIsCurrent()) throw new InboxConversionSupersededError();

      const noteActivation = noteCreateActivationRef.current;
      const noteRecoveryIntent: NoteMutationCoordinatorIntent | null =
        feedback.outputKind === 'note'
          ? noteMutationCoordinator.begin(noteActivation, 'recover')
          : null;
      if (
        feedback.outputKind === 'note' &&
        (noteActivation.workspaceId !== feedback.workspaceId || noteRecoveryIntent === null)
      ) {
        if (noteRecoveryIntent !== null) noteMutationCoordinator.end(noteRecoveryIntent);
        throw new Error('这个工作区正在处理另一项笔记写入，请稍候。');
      }
      const isCurrent = () =>
        warningIsCurrent() &&
        (noteRecoveryIntent === null ||
          noteMutationCoordinator.isCurrent(noteRecoveryIntent, noteCreateActivationRef.current));

      try {
        const initialInbox = inboxController.isCommittedConversionSourceArchived(
          feedback.workspaceId,
          feedback.sourceEntryId,
        );
        const sharedReconciliationInput = {
          initialInboxCommitted: initialInbox,
          getCommittedInbox: () =>
            inboxController.isCommittedConversionSourceArchived(
              feedback.workspaceId,
              feedback.sourceEntryId,
            ),
          prepareInboxSnapshotRefresh: inboxController.prepareSnapshotRefresh,
          inboxSnapshotIsCommitted: (
            snapshot: Parameters<typeof isInboxConversionSourceArchived>[2],
          ) =>
            isInboxConversionSourceArchived(feedback.workspaceId, feedback.sourceEntryId, snapshot),
          isCurrent,
        };

        let outputTitle: string;
        if (feedback.outputKind === 'task') {
          const getCommittedOutput = () =>
            taskController.getCommittedConvertedTask(
              feedback.workspaceId,
              feedback.sourceEntryId,
              feedback.outputId,
            );
          const initialOutput = getCommittedOutput();
          const reconciliation = await reconcileInboxConversionSnapshots({
            ...sharedReconciliationInput,
            initialOutputCommitted: initialOutput !== null,
            getCommittedOutput,
            prepareOutputSnapshotRefresh: taskController.prepareSnapshotRefresh,
            outputFromSnapshot: (snapshot) =>
              convertedTaskFromSnapshot(
                feedback.workspaceId,
                feedback.sourceEntryId,
                feedback.outputId,
                snapshot,
              ),
          });
          if (!isCurrent() || !reconciliation.committed || reconciliation.output === null) {
            throw new Error('The committed inbox task conversion could not be reconciled.');
          }
          outputTitle = reconciliation.output.title;
        } else {
          const getCommittedOutput = () =>
            noteController.getCommittedConvertedNote(
              feedback.workspaceId,
              feedback.sourceEntryId,
              feedback.outputId,
            );
          const initialOutput = getCommittedOutput();
          const reconciliation = await reconcileInboxConversionSnapshots({
            ...sharedReconciliationInput,
            initialOutputCommitted: initialOutput !== null,
            getCommittedOutput,
            prepareOutputSnapshotRefresh: noteController.prepareSnapshotRefresh,
            outputFromSnapshot: (snapshot) =>
              convertedNoteFromSnapshot(
                feedback.workspaceId,
                feedback.sourceEntryId,
                feedback.outputId,
                snapshot,
              ),
          });
          if (!isCurrent() || !reconciliation.committed || reconciliation.output === null) {
            throw new Error('The committed inbox note conversion could not be reconciled.');
          }
          outputTitle = reconciliation.output.title;
        }

        publishInboxConversionPublication({
          kind: 'feedback',
          activation: warning.activation,
          feedback: Object.freeze({
            ...feedback,
            outputTitle,
          }),
        });
      } finally {
        if (noteRecoveryIntent !== null) noteMutationCoordinator.end(noteRecoveryIntent);
      }
    },
    [
      inboxController,
      inboxConversionRequestCoordinator,
      noteController,
      noteMutationCoordinator,
      publishInboxConversionPublication,
      taskController,
    ],
  );

  const openInboxConversionOutput = useCallback(
    async (feedback: InboxConversionFeedback): Promise<void> => {
      if (feedback.outputKind === 'note') {
        assertNoteOutputNavigationAvailable(feedback.workspaceId);
      }
      automationCreateCoordinator.cancelOpen();
      taskCreateCoordinator.cancelOpen();
      try {
        const intent = inboxConversionNavigation.begin(
          inboxConversionActivationRef.current,
          feedback,
        );
        const assertCurrent = () =>
          inboxConversionNavigation.assertCurrent(
            intent,
            inboxConversionActivationRef.current,
            currentSurfaceRef.current,
            inboxConversionFeedbackRef.current,
          );
        const target = await resolveInboxConversionNavigationTarget(
          intent,
          {
            task: taskController.prepareSnapshotRefresh,
            note: noteController.prepareSnapshotRefresh,
          },
          assertCurrent,
        );
        assertCurrent();
        if (!activeWorkspace || activeWorkspace.id !== target.workspaceId) {
          throw new InboxConversionSupersededError();
        }

        setPaletteOpen(false);
        setAssistantSurfaceOpen(false);
        setInboxReveal(null);
        if (target.kind === 'task') {
          setRequestedNoteId(null);
          updatePreferences({ activeView: 'tasks' }, true, target.workspaceId);
          setTaskDialog({
            mode: 'rename',
            workspaceId: target.workspaceId,
            workspaceName: activeWorkspace.name,
            task: target.task,
          });
          return;
        }

        updatePreferences({ activeView: 'notes' }, true, target.workspaceId);
        setRequestedNoteId(target.note.id);
      } catch (error) {
        throw inboxConversionNavigationError(error, feedback.outputKind);
      }
    },
    [
      activeWorkspace,
      assertNoteOutputNavigationAvailable,
      automationCreateCoordinator,
      inboxConversionNavigation,
      noteController.prepareSnapshotRefresh,
      taskController.prepareSnapshotRefresh,
      taskCreateCoordinator,
      updatePreferences,
    ],
  );

  const reconcileAutomationRunFeedback = useCallback(
    (feedback: AutomationRunFeedback, isCurrent: () => boolean) =>
      reconcileAutomationRunOutput({
        feedback,
        getCommittedTaskSnapshot: () => getCommittedTaskSnapshot(feedback.workspaceId),
        getCommittedNoteSnapshot: () => getCommittedNoteSnapshot(feedback.workspaceId),
        prepareTaskSnapshotRefresh,
        prepareNoteSnapshotRefresh,
        isCurrent,
      }),
    [
      getCommittedNoteSnapshot,
      getCommittedTaskSnapshot,
      prepareNoteSnapshotRefresh,
      prepareTaskSnapshotRefresh,
    ],
  );

  const runAutomationNow = useCallback(
    async (item: AutomationItem): Promise<void> => {
      const activation = automationOutputActivationRef.current;
      const workspaceId = activation.workspaceId;
      if (
        workspaceId === null ||
        currentWorkspaceIdRef.current !== workspaceId ||
        currentSurfaceRef.current !== 'automations'
      ) {
        throw new Error('当前工作区或页面已经变化，请重新确认后运行自动化。');
      }
      const currentPublication = automationRunPublicationsRef.current.get(workspaceId);
      if (currentPublication?.kind === 'warning') {
        throw new Error('上一次自动化已经运行，请先重新读取并确认输出，不要再次运行。');
      }
      const noteActivation = noteCreateActivationRef.current;
      const noteMutationIntent: NoteMutationCoordinatorIntent | null =
        item.action.kind === 'create-note'
          ? noteMutationCoordinator.begin(noteActivation, 'create')
          : null;
      if (
        item.action.kind === 'create-note' &&
        (noteActivation.workspaceId !== workspaceId ||
          noteWriteIsBlocked(noteActivation) ||
          noteMutationIntent === null)
      ) {
        if (noteMutationIntent !== null) noteMutationCoordinator.end(noteMutationIntent);
        throw new Error('这个工作区正在处理或确认另一项笔记写入，请稍候。');
      }
      const intent = automationRunReconciliationCoordinator.begin(activation, `run:${item.id}`);
      if (intent === null) {
        if (noteMutationIntent !== null) noteMutationCoordinator.end(noteMutationIntent);
        throw new Error('这个工作区正在运行或确认另一条自动化，请稍候。');
      }

      setAutomationRunActivity(workspaceId, {
        automationId: item.id,
        phase: 'running',
      });
      automationRunFeedbackRef.current = null;
      automationOutputNavigation.invalidate();
      setAutomationRunPublication(workspaceId, null);
      let feedback: AutomationRunFeedback | null = null;
      try {
        feedback = await automationController.runNow(item);
        if (
          !automationRunReconciliationCoordinator.isActive(intent) ||
          (noteMutationIntent !== null && !noteMutationCoordinator.isActive(noteMutationIntent))
        ) {
          return;
        }
        setAutomationRunActivity(workspaceId, {
          automationId: item.id,
          phase: 'confirming',
        });

        const isCurrent = () =>
          automationRunReconciliationCoordinator.isCurrent(
            intent,
            automationOutputActivationRef.current,
          ) &&
          (noteMutationIntent === null ||
            noteMutationCoordinator.isCurrent(noteMutationIntent, noteCreateActivationRef.current));
        const reconciliation = await reconcileAutomationRunFeedback(feedback, isCurrent);
        if (!automationRunReconciliationCoordinator.isActive(intent)) return;

        if (reconciliation.committed && isCurrent()) {
          setAutomationRunPublication(workspaceId, {
            kind: 'feedback',
            feedback,
          });
          return;
        }

        setAutomationRunPublication(workspaceId, {
          kind: 'warning',
          feedback,
          focusActionOnMount:
            currentWorkspaceIdRef.current === workspaceId &&
            currentSurfaceRef.current === 'automations',
          refreshing: false,
          refreshError: null,
        });
      } catch (error) {
        if (feedback !== null && automationRunReconciliationCoordinator.isActive(intent)) {
          setAutomationRunPublication(workspaceId, {
            kind: 'warning',
            feedback,
            focusActionOnMount:
              currentWorkspaceIdRef.current === workspaceId &&
              currentSurfaceRef.current === 'automations',
            refreshing: false,
            refreshError: null,
          });
          return;
        }
        throw error;
      } finally {
        finishAutomationRunIntent(intent);
        if (noteMutationIntent !== null) noteMutationCoordinator.end(noteMutationIntent);
      }
    },
    [
      automationController,
      automationOutputNavigation,
      automationRunReconciliationCoordinator,
      finishAutomationRunIntent,
      noteMutationCoordinator,
      noteWriteIsBlocked,
      reconcileAutomationRunFeedback,
      setAutomationRunActivity,
      setAutomationRunPublication,
    ],
  );

  const refreshAutomationRunSyncWarning = useCallback(
    async (feedback: AutomationRunFeedback): Promise<void> => {
      const activation = automationOutputActivationRef.current;
      const workspaceId = activation.workspaceId;
      const feedbackKey = automationRunFeedbackKey(feedback);
      const currentPublication =
        workspaceId === null ? null : automationRunPublicationsRef.current.get(workspaceId);
      if (
        workspaceId === null ||
        workspaceId !== feedback.workspaceId ||
        currentPublication?.kind !== 'warning' ||
        automationRunFeedbackKey(currentPublication.feedback) !== feedbackKey
      ) {
        throw new Error('这条自动化运行恢复状态已经变化。');
      }

      const noteActivation = noteCreateActivationRef.current;
      const noteRecoveryIntent: NoteMutationCoordinatorIntent | null =
        feedback.outputKind === 'note'
          ? noteMutationCoordinator.begin(noteActivation, 'recover')
          : null;
      if (
        feedback.outputKind === 'note' &&
        (noteActivation.workspaceId !== workspaceId || noteRecoveryIntent === null)
      ) {
        if (noteRecoveryIntent !== null) noteMutationCoordinator.end(noteRecoveryIntent);
        throw new Error('这个工作区正在处理另一项笔记写入，请稍候。');
      }
      const intent = automationRunReconciliationCoordinator.begin(
        activation,
        `recover:${feedbackKey}`,
      );
      if (intent === null) {
        if (noteRecoveryIntent !== null) noteMutationCoordinator.end(noteRecoveryIntent);
        throw new Error('这个工作区正在运行或确认另一条自动化，请稍候。');
      }
      setAutomationRunActivity(workspaceId, {
        automationId: feedback.automationId,
        phase: 'recovering',
      });
      setAutomationRunPublication(workspaceId, {
        ...currentPublication,
        refreshing: true,
        refreshError: null,
      });

      const isCurrent = () => {
        const publication = automationRunPublicationsRef.current.get(workspaceId);
        return (
          automationRunReconciliationCoordinator.isCurrent(
            intent,
            automationOutputActivationRef.current,
          ) &&
          (noteRecoveryIntent === null ||
            noteMutationCoordinator.isCurrent(
              noteRecoveryIntent,
              noteCreateActivationRef.current,
            )) &&
          publication?.kind === 'warning' &&
          automationRunFeedbackKey(publication.feedback) === feedbackKey
        );
      };

      try {
        const reconciliation = await reconcileAutomationRunFeedback(feedback, isCurrent);
        if (!automationRunReconciliationCoordinator.isActive(intent)) return;
        if (!reconciliation.committed || !isCurrent()) {
          throw new Error('The exact automation output could not be reconciled.');
        }
        setAutomationRunPublication(workspaceId, {
          kind: 'feedback',
          feedback,
        });
      } catch (error) {
        if (automationRunReconciliationCoordinator.isActive(intent)) {
          const publication = automationRunPublicationsRef.current.get(workspaceId);
          if (
            publication?.kind === 'warning' &&
            automationRunFeedbackKey(publication.feedback) === feedbackKey
          ) {
            const outputLabel = feedback.outputKind === 'task' ? '任务' : '笔记';
            setAutomationRunPublication(workspaceId, {
              ...publication,
              refreshing: false,
              refreshError: `重新读取后仍无法确认刚创建的${outputLabel}。请稍后再试；自动化已经运行，请不要再次运行。`,
            });
          }
        }
        throw error;
      } finally {
        finishAutomationRunIntent(intent);
        if (noteRecoveryIntent !== null) noteMutationCoordinator.end(noteRecoveryIntent);
      }
    },
    [
      automationRunReconciliationCoordinator,
      finishAutomationRunIntent,
      noteMutationCoordinator,
      reconcileAutomationRunFeedback,
      setAutomationRunActivity,
      setAutomationRunPublication,
    ],
  );

  const openAutomationRunOutput = useCallback(
    async (feedback: AutomationRunFeedback): Promise<void> => {
      if (feedback.outputKind === 'note') {
        assertNoteOutputNavigationAvailable(feedback.workspaceId);
      }
      automationCreateCoordinator.cancelOpen();
      taskCreateCoordinator.cancelOpen();
      try {
        const intent = automationOutputNavigation.begin(
          automationOutputActivationRef.current,
          feedback,
        );
        const assertCurrent = () =>
          automationOutputNavigation.assertCurrent(
            intent,
            automationOutputActivationRef.current,
            currentSurfaceRef.current,
            automationRunFeedbackRef.current,
          );
        const target = await resolveAutomationOutputNavigationTarget(
          intent,
          {
            task: taskController.prepareSnapshotRefresh,
            note: noteController.prepareSnapshotRefresh,
          },
          assertCurrent,
        );
        assertCurrent();
        if (!activeWorkspace || activeWorkspace.id !== target.workspaceId) {
          throw new Error('当前工作区已变化，无法打开刚创建的内容。');
        }

        setPaletteOpen(false);
        setAssistantSurfaceOpen(false);
        setInboxReveal(null);
        if (target.kind === 'task') {
          setRequestedNoteId(null);
          updatePreferences({ activeView: 'tasks' }, true, target.workspaceId);
          setTaskDialog({
            mode: 'rename',
            workspaceId: target.workspaceId,
            workspaceName: activeWorkspace.name,
            task: target.task,
          });
          return;
        }

        updatePreferences({ activeView: 'notes' }, true, target.workspaceId);
        setRequestedNoteId(target.note.id);
      } catch (error) {
        throw automationOutputNavigationError(error, feedback.outputKind);
      }
    },
    [
      activeWorkspace,
      assertNoteOutputNavigationAvailable,
      automationCreateCoordinator,
      automationOutputNavigation,
      noteController.prepareSnapshotRefresh,
      taskController.prepareSnapshotRefresh,
      taskCreateCoordinator,
      updatePreferences,
    ],
  );

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    document.documentElement.style.colorScheme = theme;
  }, [theme]);

  useEffect(() => {
    void window.workbench?.app
      .getVersion()
      .then(setAppVersion)
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    if (activeSurface === 'settings') void loadData();
  }, [activeSurface, loadData]);

  useEffect(() => window.workbench.inbox.onCaptureRequest(openQuickCapture), [openQuickCapture]);

  useEffect(
    () =>
      window.workbench.browser.onOpenUrlRequest(({ workspaceId, url }) => {
        openUrlInWorkspace(workspaceId, url);
      }),
    [openUrlInWorkspace],
  );

  useEffect(
    () =>
      window.workbench.window.onCloseRequest(async (request) => {
        const importPreview = currentImportPreview();
        const decision = evaluateWindowCloseProtection(
          {
            reason: request.reason,
            hasUnsavedDraft: noteDraftDirtyRef.current,
            noteDiscardPreviouslyApproved: dataReplacementNoteDiscardApprovedRef.current,
            dataReplacementApproved: dataReplacementApprovedRef.current,
            importPreviewOpen: importPreview !== null,
            importCommitInFlight: isImportCommitInFlight(),
          },
          () => window.confirm('当前笔记有尚未保存的更改。要放弃这些更改并继续吗？'),
          () =>
            window.confirm(
              '导入预览尚未关闭。退出会安全取消本次导入，且不会修改本地数据。要继续吗？',
            ),
        );
        if (decision === 'reject') return false;
        if (decision === 'approve') {
          if (dataReplacementCloseApproved(request.reason, decision)) {
            invalidateAutomationRuns();
            invalidateInboxCapture();
            invalidateInboxConversion();
            invalidateAutomationCreate();
            invalidateScheduleCreate();
            invalidateNoteMutations();
            invalidateScheduleMutations();
          }
          return true;
        }
        try {
          await cancelImport();
          return currentImportPreview() === null;
        } catch {
          return false;
        }
      }),
    [
      cancelImport,
      currentImportPreview,
      invalidateAutomationCreate,
      invalidateAutomationRuns,
      invalidateInboxCapture,
      invalidateInboxConversion,
      invalidateNoteMutations,
      invalidateScheduleCreate,
      invalidateScheduleMutations,
      isImportCommitInFlight,
    ],
  );

  useEffect(() => {
    const protectDraft = (event: BeforeUnloadEvent) => {
      if (
        !shouldProtectWindowUnload(noteDraftDirtyRef.current || currentImportPreview() !== null)
      ) {
        return;
      }
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', protectDraft);
    return () => window.removeEventListener('beforeunload', protectDraft);
  }, [currentImportPreview]);

  useEffect(() => {
    const updateViewport = () => setViewportHeight(window.innerHeight);
    window.addEventListener('resize', updateViewport);
    return () => window.removeEventListener('resize', updateViewport);
  }, []);

  useEffect(
    () => () => {
      activeResizeFinishRef.current?.();
    },
    [],
  );

  useEffect(() => {
    if (!snapshot) return;
    const handleShortcut = (event: KeyboardEvent) => {
      if (
        archiveManager.open ||
        workspaceDialog !== null ||
        taskDialog !== null ||
        scheduleDialog !== null ||
        automationDialog !== null ||
        focusDialogOpen ||
        dataState.importPreview !== null ||
        workspaceController.pendingOperation !== null
      ) {
        return;
      }
      const commandKey = event.ctrlKey || event.metaKey;
      if (
        isQuickCaptureShortcut({
          type: 'keyDown',
          key: event.key,
          control: event.ctrlKey,
          meta: event.metaKey,
          alt: event.altKey,
          shift: event.shiftKey,
          repeat: event.repeat,
          composing: event.isComposing,
        })
      ) {
        event.preventDefault();
        if (!quickCaptureTarget) openQuickCapture();
        return;
      }
      if (event.defaultPrevented || event.isComposing) return;
      if (quickCaptureTarget) return;
      if (commandKey && event.key.toLowerCase() === 'k' && !isTerminalTarget(event.target)) {
        event.preventDefault();
        inboxCaptureCoordinator.cancelOpen();
        setPaletteOpen((open) => !open);
        return;
      }
      if (isEditableTarget(event.target)) return;
      if (!commandKey) {
        if (event.key === 'Escape' && paletteOpen) setPaletteOpen(false);
        return;
      }

      if (paletteOpen && event.key.toLowerCase() !== 'k') return;

      if (event.key.toLowerCase() === 'b' && event.shiftKey) {
        event.preventDefault();
        updatePreferences({ browserOpen: !browserOpen });
      } else if (event.key.toLowerCase() === 'b') {
        event.preventDefault();
        updatePreferences({ sidebarCollapsed: !sidebarCollapsed });
      } else if (event.key.toLowerCase() === 'j' || event.code === 'Backquote') {
        event.preventDefault();
        updatePreferences({ terminalOpen: !terminalOpen });
      } else if (event.key === ',') {
        event.preventDefault();
        requestActiveView('settings');
      }
    };

    window.addEventListener('keydown', handleShortcut);
    return () => window.removeEventListener('keydown', handleShortcut);
  }, [
    archiveManager.open,
    browserOpen,
    automationDialog,
    dataState.importPreview,
    focusDialogOpen,
    inboxCaptureCoordinator,
    paletteOpen,
    quickCaptureTarget,
    sidebarCollapsed,
    snapshot,
    terminalOpen,
    updatePreferences,
    openQuickCapture,
    workspaceController.pendingOperation,
    workspaceDialog,
    taskDialog,
    scheduleDialog,
    requestActiveView,
  ]);

  const selectSearchResult = useCallback(
    async (selectedResult: SearchResult): Promise<void> => {
      if (
        selectedResult.workspaceId !== currentWorkspaceIdRef.current &&
        noteWorkspaceChangeIsBlocked()
      ) {
        throw new Error(
          '笔记写入仍在确认，请先返回当前工作区完成重新读取，再打开其他工作区的搜索结果。',
        );
      }
      if (
        selectedResult.workspaceId !== currentWorkspaceIdRef.current &&
        scheduleWorkspaceChangeIsBlocked()
      ) {
        throw new Error(
          '日程写入仍在确认，请先在当前工作区完成重新读取，再打开其他工作区的搜索结果。',
        );
      }
      if (
        selectedResult.kind === 'schedule' &&
        (scheduleMutationCoordinator.isPending(currentWorkspaceIdRef.current) ||
          scheduleWriteIsBlocked(scheduleMutationActivationRef.current))
      ) {
        throw new Error('日程写入仍在确认，请先完成重新读取，再打开其他日程。');
      }
      if (
        isNoteCreateNavigationBlocked(noteController.pendingCreate, visibleNoteCreateSyncWarning)
      ) {
        throw new Error('刚创建的笔记仍在确认，请先返回笔记页面完成重新读取，再打开搜索结果。');
      }
      const activeNoteMutationWarning = noteMutationSyncWarningForActivation(
        noteCreateActivationRef.current,
        noteMutationSyncWarningRef.current,
      );
      if (
        isNoteMutationNavigationBlocked(
          noteMutationCoordinator.isPending(currentWorkspaceIdRef.current) ||
            noteController.pendingMutation,
          activeNoteMutationWarning,
        )
      ) {
        throw new Error('笔记写入仍在确认，请先返回笔记页面完成重新读取，再打开搜索结果。');
      }
      if (!confirmLeaveNoteDraft()) {
        throw new Error('已取消打开搜索结果；当前笔记仍保留未保存的更改。');
      }
      automationOutputNavigation.invalidate();
      automationCreateCoordinator.cancelOpen();
      inboxCaptureCoordinator.cancelOpen();
      taskCreateCoordinator.cancelOpen();
      inboxConversionNavigation.invalidate();
      const discardConfirmedNoteDraft = noteDraftDirtyRef.current;
      const intent = searchNavigation.begin(selectedResult);
      if (workspaceController.pendingOperation !== null) {
        throw new Error('工作区操作正在进行，请稍候再打开搜索结果。');
      }

      const { result } = intent;
      const assertCurrent = () => searchNavigation.assertCurrent(intent);
      const finishNavigation = () => {
        if (discardConfirmedNoteDraft) {
          setNotePageGeneration((generation) => generation + 1);
        }
      };
      try {
        if (currentWorkspaceIdRef.current !== result.workspaceId) {
          await workspaceController.activate(result.workspaceId);
          assertCurrent();
        }

        switch (result.kind) {
          case 'inbox': {
            const inboxSnapshot = await window.workbench.inbox.getSnapshot({
              workspaceId: result.workspaceId,
            });
            assertCurrent();
            assertSearchTargetExists(
              intent,
              inboxSnapshot.entries.some(({ id }) => id === result.entityId),
            );
            finishNavigation();
            setAssistantSurfaceOpen(false);
            updatePreferences({ activeView: 'inbox' }, true, result.workspaceId);
            setRequestedNoteId(null);
            setInboxReveal({
              workspaceId: result.workspaceId,
              entryId: result.entityId,
              generation: intent.generation,
              handled: false,
            });
            return;
          }
          case 'task': {
            const taskSnapshot = await window.workbench.task.getSnapshot({
              workspaceId: result.workspaceId,
            });
            assertCurrent();
            const task = taskSnapshot.tasks.find(({ id }) => id === result.entityId);
            assertSearchTargetExists(intent, task !== undefined);
            finishNavigation();
            setAssistantSurfaceOpen(false);
            updatePreferences({ activeView: 'tasks' }, true, result.workspaceId);
            setInboxReveal(null);
            setRequestedNoteId(null);
            setTaskDialog({
              mode: 'rename',
              workspaceId: result.workspaceId,
              workspaceName: result.workspaceName,
              task,
            });
            return;
          }
          case 'note': {
            const noteSnapshot = await window.workbench.note.getSnapshot({
              workspaceId: result.workspaceId,
            });
            assertCurrent();
            assertSearchTargetExists(
              intent,
              noteSnapshot.notes.some(({ id }) => id === result.entityId),
            );
            finishNavigation();
            setAssistantSurfaceOpen(false);
            updatePreferences({ activeView: 'notes' }, true, result.workspaceId);
            setInboxReveal(null);
            setRequestedNoteId(result.entityId);
            return;
          }
          case 'schedule': {
            const scheduleSnapshot = await window.workbench.schedule.getSnapshot({
              workspaceId: result.workspaceId,
            });
            assertCurrent();
            const item = scheduleSnapshot.items.find(({ id }) => id === result.entityId);
            assertSearchTargetExists(intent, item !== undefined);
            finishNavigation();
            setAssistantSurfaceOpen(false);
            updatePreferences({ activeView: 'today' }, true, result.workspaceId);
            setInboxReveal(null);
            setRequestedNoteId(null);
            setScheduleDialog({
              mode: 'edit',
              workspaceId: result.workspaceId,
              workspaceName: result.workspaceName,
              expectedDate: item.scheduledFor,
              item,
            });
            return;
          }
          case 'browser-tab': {
            const browserSnapshot = await window.workbench.browser.getSnapshot({
              workspaceId: result.workspaceId,
            });
            assertCurrent();
            assertSearchTargetExists(
              intent,
              browserSnapshot.tabs.some(({ id }) => id === result.entityId),
            );
            const activated = await window.workbench.browser.activateTab({
              workspaceId: result.workspaceId,
              tabId: result.entityId,
            });
            assertCurrent();
            assertSearchTargetExists(
              intent,
              activated.activeTabId === result.entityId &&
                activated.tabs.some(({ id }) => id === result.entityId),
            );
            finishNavigation();
            updatePreferences({ browserOpen: true }, true, result.workspaceId);
            setInboxReveal(null);
            setRequestedNoteId(null);
            return;
          }
          case 'browser-bookmark': {
            const browserSnapshot = await window.workbench.browser.getSnapshot({
              workspaceId: result.workspaceId,
            });
            assertCurrent();
            assertSearchTargetExists(
              intent,
              browserSnapshot.bookmarks.some(({ id }) => id === result.entityId),
            );
            await window.workbench.browser.openBookmark({
              workspaceId: result.workspaceId,
              bookmarkId: result.entityId,
              newTab: false,
            });
            assertCurrent();
            finishNavigation();
            updatePreferences({ browserOpen: true }, true, result.workspaceId);
            setInboxReveal(null);
            setRequestedNoteId(null);
          }
        }
      } catch (error) {
        throw searchNavigationError(error);
      }
    },
    [
      automationCreateCoordinator,
      automationOutputNavigation,
      confirmLeaveNoteDraft,
      inboxCaptureCoordinator,
      inboxConversionNavigation,
      noteController.pendingCreate,
      noteController.pendingMutation,
      noteMutationCoordinator,
      noteWorkspaceChangeIsBlocked,
      scheduleMutationCoordinator,
      scheduleWorkspaceChangeIsBlocked,
      scheduleWriteIsBlocked,
      searchNavigation,
      taskCreateCoordinator,
      updatePreferences,
      visibleNoteCreateSyncWarning,
      workspaceController,
    ],
  );

  const commands = useMemo<PaletteCommand[]>(() => {
    if (!snapshot || !activeWorkspace) return [];
    const dataBusy = dataState.activeOperation !== null;
    const dataDisabled = dataBusy || dataState.importPreview !== null;
    const dataDisabledReason = dataBusy
      ? '另一项数据操作正在进行'
      : dataState.importPreview
        ? '请先处理当前导入预览'
        : undefined;
    const manualBackupDisabled = dataDisabled || manualBackupBlocked;
    const manualBackupDisabledReason = manualBackupBlocked
      ? '备份已创建，请先重新读取确认'
      : dataDisabledReason;
    const workspaceWriteBlocked = noteWorkspaceChangeBlocked || scheduleWorkspaceChangeBlocked;
    const workspaceWriteBlockedReason = scheduleWorkspaceChangeBlocked
      ? '请先确认当前日程写入'
      : noteWorkspaceChangeBlocked
        ? '请先确认当前笔记写入'
        : undefined;
    const workspaceCommands: PaletteCommand[] = snapshot.workspaces
      .filter(({ id }) => id !== activeWorkspace.id)
      .map((workspace) => ({
        id: `workspace:activate:${workspace.id}`,
        label: `切换到 ${workspace.name}`,
        description: '恢复该工作区的页面与面板布局',
        group: '工作区',
        icon: Layers3,
        keywords: `工作区 切换 ${workspace.name}`,
        disabled: workspaceWriteBlocked,
        disabledReason: workspaceWriteBlockedReason,
        action: () => {
          requestWorkspaceActivation(workspace.id);
        },
      }));

    return [
      {
        id: 'capture',
        label: '快速记录',
        description: '把一个想法或任务加入收件箱',
        group: '操作',
        icon: Plus,
        shortcut: 'Ctrl N',
        keywords: '新建 添加 任务 笔记',
        action: () => {
          openQuickCapture();
        },
      },
      {
        id: 'task:create',
        label: '新建任务',
        description: '创建一项真实任务，稍后安排时间',
        group: '操作',
        icon: CheckSquare2,
        keywords: '任务 新建 创建 todo',
        action: () => openTaskCreate('none'),
      },
      {
        id: 'automation:create',
        label: '新建自动化',
        description: '按每日或每周计划创建任务或笔记',
        group: '操作',
        icon: Bot,
        keywords: '自动化 定时 每日 每周 任务 笔记',
        action: openAutomationCreate,
      },
      {
        id: 'data:backup',
        label: '立即备份数据',
        description: '创建一份一致性的本地 SQLite 备份',
        group: '数据',
        icon: Archive,
        keywords: '数据 备份 backup sqlite',
        disabled: manualBackupDisabled,
        disabledReason: manualBackupDisabledReason,
        action: createBackup,
      },
      {
        id: 'data:export',
        label: '导出数据',
        description: '保存经过校验的可移植数据文件',
        group: '数据',
        icon: Download,
        keywords: '数据 导出 export portable',
        disabled: dataDisabled,
        disabledReason: dataDisabledReason,
        action: exportData,
      },
      {
        id: 'data:import',
        label: '导入数据',
        description: '选择文件并在替换前查看完整预览',
        group: '数据',
        icon: Upload,
        keywords: '数据 导入 import restore',
        disabled: dataDisabled,
        disabledReason: dataDisabledReason,
        restoreFocus: false,
        action: chooseImport,
      },
      {
        id: 'workspace:create',
        label: '新建工作区',
        description: '创建一个独立的本地布局',
        group: '工作区',
        icon: FolderPlus,
        keywords: '工作区 新建 创建',
        disabled: workspaceWriteBlocked,
        disabledReason: workspaceWriteBlockedReason,
        action: () => {
          if (noteWorkspaceChangeIsBlocked() || scheduleWorkspaceChangeIsBlocked()) return;
          if (!confirmLeaveNoteDraft()) return;
          setWorkspaceDialog({
            mode: 'create',
            suggestedColor: WORKSPACE_COLORS[snapshot.workspaces.length % WORKSPACE_COLORS.length],
          });
        },
      },
      {
        id: 'workspace:archives',
        label: '管理归档工作区',
        description: '查看并恢复保留在本机的工作区',
        group: '工作区',
        icon: ArchiveRestore,
        keywords: '工作区 归档 恢复 restore archive',
        disabled: workspaceController.pendingOperation !== null || workspaceWriteBlocked,
        disabledReason:
          workspaceController.pendingOperation !== null
            ? '另一项工作区操作正在进行'
            : workspaceWriteBlockedReason,
        action: workspaceController.openArchiveManager,
      },
      {
        id: 'workspace:rename',
        label: '重命名当前工作区',
        description: activeWorkspace.name,
        group: '工作区',
        icon: Pencil,
        disabled: workspaceWriteBlocked,
        disabledReason: workspaceWriteBlockedReason,
        action: () => setWorkspaceDialog({ mode: 'rename', workspace: activeWorkspace }),
      },
      ...workspaceCommands,
      ...(snapshot.workspaces.length > 1
        ? [
            {
              id: 'workspace:archive',
              label: '归档当前工作区',
              description: '保留数据并从活动列表隐藏',
              group: '工作区',
              icon: Archive,
              disabled: workspaceWriteBlocked,
              disabledReason: workspaceWriteBlockedReason,
              action: () => {
                if (noteWorkspaceChangeIsBlocked() || scheduleWorkspaceChangeIsBlocked()) return;
                if (!confirmLeaveNoteDraft()) return;
                setWorkspaceDialog({
                  mode: 'archive',
                  workspace: activeWorkspace,
                  switchesWorkspace: true,
                });
              },
            } satisfies PaletteCommand,
          ]
        : []),
      {
        id: 'toggle-browser',
        label: browserOpen ? '关闭右侧浏览器' : '打开右侧浏览器',
        description: '显示内置浏览器',
        group: '工具',
        icon: Globe2,
        shortcut: 'Ctrl ⇧ B',
        keywords: '网页 web panel',
        action: () => updatePreferences({ browserOpen: !browserOpen }),
      },
      {
        id: 'toggle-terminal',
        label: terminalOpen ? '关闭集成终端' : '打开集成终端',
        description: '显示集成 Shell',
        group: '工具',
        icon: SquareTerminal,
        shortcut: 'Ctrl J',
        keywords: '命令行 shell powershell',
        action: () => updatePreferences({ terminalOpen: !terminalOpen }),
      },
      {
        id: 'terminal:settings',
        label: '配置集成终端',
        description: '选择当前工作区的 Profile、启动目录与 WSL 发行版',
        group: '工具',
        icon: Settings2,
        keywords: '终端 profile shell cwd wsl 工作目录',
        action: openTerminalSettings,
      },
      {
        id: 'go-assistant',
        label: '打开 AI 助手',
        description: '选择上下文后手动发送问题',
        group: '页面',
        icon: Sparkles,
        keywords: 'AI OpenAI 助手 问答',
        action: () => requestActiveView('assistant'),
      },
      {
        id: 'go-today',
        label: '前往今日',
        group: '页面',
        icon: LayoutDashboard,
        action: () => requestActiveView('today'),
      },
      {
        id: 'go-inbox',
        label: '前往收件箱',
        group: '页面',
        icon: Inbox,
        action: () => requestActiveView('inbox'),
      },
      {
        id: 'go-tasks',
        label: '前往任务',
        group: '页面',
        icon: CheckSquare2,
        action: () => requestActiveView('tasks'),
      },
      {
        id: 'go-notes',
        label: '前往笔记',
        group: '页面',
        icon: NotebookPen,
        action: () => requestActiveView('notes'),
      },
      {
        id: 'go-automations',
        label: '前往自动化',
        group: '页面',
        icon: Bot,
        action: () => requestActiveView('automations'),
      },
      {
        id: 'toggle-theme',
        label: theme === 'dark' ? '切换为浅色主题' : '切换为深色主题',
        group: '设置',
        icon: theme === 'dark' ? Sun : Moon,
        keywords: '外观 颜色 dark light',
        action: () => updatePreferences({ theme: theme === 'dark' ? 'light' : 'dark' }),
      },
      {
        id: 'open-settings',
        label: '打开设置',
        group: '设置',
        icon: Settings2,
        shortcut: 'Ctrl ,',
        action: () => requestActiveView('settings'),
      },
    ];
  }, [
    activeWorkspace,
    browserOpen,
    chooseImport,
    createBackup,
    dataState.activeOperation,
    dataState.importPreview,
    exportData,
    manualBackupBlocked,
    openAutomationCreate,
    openQuickCapture,
    openTerminalSettings,
    openTaskCreate,
    confirmLeaveNoteDraft,
    noteWorkspaceChangeBlocked,
    noteWorkspaceChangeIsBlocked,
    scheduleWorkspaceChangeBlocked,
    scheduleWorkspaceChangeIsBlocked,
    requestActiveView,
    requestWorkspaceActivation,
    snapshot,
    terminalOpen,
    theme,
    updatePreferences,
    workspaceController.openArchiveManager,
    workspaceController.pendingOperation,
  ]);

  const beginBrowserResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!snapshot) return;
    event.preventDefault();
    activeResizeFinishRef.current?.();
    const workspaceId = snapshot.currentWorkspaceId;
    const pointerId = event.pointerId;
    const resizeHandle = event.currentTarget;
    resizeHandle.setPointerCapture(pointerId);
    const startX = event.clientX;
    const startWidth = browserWidth;
    let latestWidth = startWidth;
    document.body.classList.add('is-resizing-horizontal');
    let finished = false;

    const move = (moveEvent: PointerEvent) => {
      if (moveEvent.pointerId !== pointerId) return;
      const maximum = Math.min(720, window.innerWidth - 560);
      latestWidth = clamp(startWidth + startX - moveEvent.clientX, 340, Math.max(340, maximum));
      updatePreferences({ browserWidth: latestWidth }, false, workspaceId);
    };
    const cleanup = () => {
      document.body.classList.remove('is-resizing-horizontal');
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', finish);
      window.removeEventListener('pointercancel', finish);
      window.removeEventListener('blur', finish);
      if (resizeHandle.hasPointerCapture(pointerId)) resizeHandle.releasePointerCapture(pointerId);
      if (activeResizeFinishRef.current === finish) activeResizeFinishRef.current = null;
    };
    const finish = (finishEvent?: Event) => {
      if (finishEvent instanceof PointerEvent && finishEvent.pointerId !== pointerId) return;
      if (finished) return;
      finished = true;
      cleanup();
      updatePreferences({ browserWidth: latestWidth }, true, workspaceId);
    };
    activeResizeFinishRef.current = finish;
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', finish);
    window.addEventListener('pointercancel', finish);
    window.addEventListener('blur', finish);
  };

  const beginTerminalResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!snapshot) return;
    event.preventDefault();
    activeResizeFinishRef.current?.();
    const workspaceId = snapshot.currentWorkspaceId;
    const pointerId = event.pointerId;
    const resizeHandle = event.currentTarget;
    resizeHandle.setPointerCapture(pointerId);
    const startY = event.clientY;
    const startHeight = effectiveTerminalHeight;
    let latestHeight = startHeight;
    document.body.classList.add('is-resizing-vertical');
    let finished = false;

    const move = (moveEvent: PointerEvent) => {
      if (moveEvent.pointerId !== pointerId) return;
      const maximum = Math.min(2160, Math.max(180, window.innerHeight - 180));
      latestHeight = clamp(startHeight + startY - moveEvent.clientY, 180, maximum);
      updatePreferences({ terminalHeight: latestHeight }, false, workspaceId);
    };
    const cleanup = () => {
      document.body.classList.remove('is-resizing-vertical');
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', finish);
      window.removeEventListener('pointercancel', finish);
      window.removeEventListener('blur', finish);
      if (resizeHandle.hasPointerCapture(pointerId)) resizeHandle.releasePointerCapture(pointerId);
      if (activeResizeFinishRef.current === finish) activeResizeFinishRef.current = null;
    };
    const finish = (finishEvent?: Event) => {
      if (finishEvent instanceof PointerEvent && finishEvent.pointerId !== pointerId) return;
      if (finished) return;
      finished = true;
      cleanup();
      updatePreferences({ terminalHeight: latestHeight }, true, workspaceId);
    };
    activeResizeFinishRef.current = finish;
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', finish);
    window.addEventListener('pointercancel', finish);
    window.addEventListener('blur', finish);
  };

  const toggleWindowMaximize = () => {
    void window.workbench?.window
      .toggleMaximize()
      .then(setMaximized)
      .catch(() => undefined);
  };

  if (!snapshot || !activeWorkspace) {
    return (
      <StartupShell
        status={workspaceController.status}
        error={workspaceController.loadError}
        canRetry={workspaceController.canRetry}
        onRetry={workspaceController.retry}
        maximized={maximized}
        onToggleMaximize={toggleWindowMaximize}
      />
    );
  }

  return (
    <div
      className="app-shell"
      onClickCapture={() => {
        automationOutputNavigation.invalidate();
        automationCreateCoordinator.cancelOpen();
        scheduleCreateCoordinator.cancelOpen();
        inboxCaptureCoordinator.cancelOpen();
      }}
    >
      <header
        className="titlebar"
        onDoubleClick={(event) => {
          if (!(event.target as HTMLElement).closest('button')) toggleWindowMaximize();
        }}
      >
        <div className="titlebar__identity">
          <span className="titlebar__logo">
            <Sparkles size={15} />
          </span>
          <strong>Daily Workbench</strong>
          <span className="titlebar__separator" />
          <span>{activeWorkspace.name}</span>
        </div>

        <button type="button" className="titlebar-command" onClick={() => setPaletteOpen(true)}>
          <Search size={14} aria-hidden="true" />
          <span>搜索或运行命令</span>
          <kbd>Ctrl K</kbd>
        </button>

        <div className="titlebar__tools">
          <IconButton
            label={sidebarCollapsed ? '展开侧边栏' : '折叠侧边栏'}
            active={!sidebarCollapsed}
            onClick={() => updatePreferences({ sidebarCollapsed: !sidebarCollapsed })}
          >
            {sidebarCollapsed ? <PanelLeftOpen size={16} /> : <PanelLeftClose size={16} />}
          </IconButton>
          <IconButton
            label="内置浏览器"
            active={browserOpen}
            onClick={() => updatePreferences({ browserOpen: !browserOpen })}
          >
            <PanelRight size={16} />
          </IconButton>
          <IconButton
            label="集成终端"
            active={terminalOpen}
            onClick={() => updatePreferences({ terminalOpen: !terminalOpen })}
          >
            <PanelBottom size={16} />
          </IconButton>
          <IconButton
            label={theme === 'dark' ? '使用浅色主题' : '使用深色主题'}
            onClick={() => updatePreferences({ theme: theme === 'dark' ? 'light' : 'dark' })}
          >
            {theme === 'dark' ? <Sun size={15} /> : <Moon size={15} />}
          </IconButton>
        </div>

        <WindowControls
          maximized={maximized}
          onToggleMaximize={toggleWindowMaximize}
          onClose={() => void window.workbench?.window.close()}
        />
      </header>

      <div className="workbench-shell">
        <ActivityRail
          activeView={activeSurface}
          inboxCount={inboxController.snapshot ? inboxController.counts.total : null}
          taskCount={taskController.counts?.active ?? null}
          todayCount={taskController.counts?.today ?? null}
          onSelect={requestActiveView}
        />
        <div
          className={`sidebar-slot ${sidebarCollapsed ? 'is-collapsed' : ''}`}
          aria-hidden={sidebarCollapsed}
          inert={sidebarCollapsed}
        >
          <WorkspaceSidebar
            activeView={activeSurface}
            activeWorkspace={activeWorkspace}
            workspaces={snapshot.workspaces}
            busy={
              workspaceController.pendingOperation !== null ||
              noteWorkspaceChangeBlocked ||
              scheduleWorkspaceChangeBlocked
            }
            pendingWorkspaceId={workspaceController.pendingWorkspaceId}
            saveError={workspaceController.saveError}
            saveStatus={workspaceController.saveStatus}
            inboxCount={inboxController.snapshot ? inboxController.counts.total : null}
            taskCount={taskController.counts?.active ?? null}
            todayCount={taskController.counts?.today ?? null}
            onRetrySave={workspaceController.retryPreferences}
            onSelectView={requestActiveView}
            onSelectWorkspace={requestWorkspaceActivation}
            onCreateWorkspace={() => {
              if (noteWorkspaceChangeIsBlocked() || scheduleWorkspaceChangeIsBlocked()) return;
              if (!confirmLeaveNoteDraft()) return;
              setWorkspaceDialog({
                mode: 'create',
                suggestedColor:
                  WORKSPACE_COLORS[snapshot.workspaces.length % WORKSPACE_COLORS.length],
              });
            }}
            onRenameWorkspace={(workspace) => setWorkspaceDialog({ mode: 'rename', workspace })}
            onArchiveWorkspace={(workspace) => {
              if (
                workspace.id === snapshot.currentWorkspaceId &&
                (noteWorkspaceChangeIsBlocked() || scheduleWorkspaceChangeIsBlocked())
              ) {
                return;
              }
              if (!confirmLeaveNoteDraft()) return;
              setWorkspaceDialog({
                mode: 'archive',
                workspace,
                switchesWorkspace: workspace.id === snapshot.currentWorkspaceId,
              });
            }}
            onManageArchivedWorkspaces={workspaceController.openArchiveManager}
          />
        </div>

        <div className="content-shell">
          <div className="horizontal-workspace">
            <main className="page-region" id="main-content">
              <div className="page-chrome">
                <div className="breadcrumbs">
                  <AppWindow size={14} />
                  <span>{activeWorkspace.name}</span>
                  <i>/</i>
                  <strong>{viewLabels[activeSurface]}</strong>
                </div>
                <div className="page-chrome__actions">
                  <IconButton label="打开命令中心" onClick={() => setPaletteOpen(true)}>
                    <Command size={15} />
                  </IconButton>
                  {!browserOpen ? (
                    <button
                      type="button"
                      className="subtle-action"
                      onClick={() => updatePreferences({ browserOpen: true })}
                    >
                      <Globe2 size={14} /> 浏览器
                    </button>
                  ) : null}
                </div>
              </div>
              <div className="page-scroll">
                {activeSurface === 'today' ? (
                  <TodayDashboard
                    key={snapshot.currentWorkspaceId}
                    inboxStatus={inboxController.status}
                    inboxCount={inboxController.snapshot ? inboxController.counts.total : null}
                    uncategorizedCount={
                      inboxController.snapshot ? inboxController.counts.uncategorized : null
                    }
                    capturePending={inboxController.pendingCapture}
                    taskSnapshot={taskController.snapshot}
                    taskStatus={taskController.status}
                    taskLoadError={taskController.loadError}
                    taskOperationError={taskController.operationError}
                    pendingTaskIds={taskController.pendingTaskIds}
                    taskCreatePending={taskController.pendingCreate}
                    onCapture={(content) =>
                      createInboxCapture(
                        snapshot.currentWorkspaceId,
                        content,
                        'uncategorized',
                        'today',
                      )
                    }
                    scheduleSnapshot={scheduleController.snapshot}
                    scheduleItems={scheduleController.items}
                    scheduleStatus={scheduleController.status}
                    scheduleLoadError={scheduleController.loadError}
                    scheduleOperationError={scheduleController.operationError}
                    pendingScheduleItemIds={scheduleController.pendingItemIds}
                    scheduleCreatePending={scheduleController.pendingCreate}
                    scheduleMutationBlocked={scheduleWorkspaceChangeBlocked}
                    workspaceNavigationBlocked={
                      noteWorkspaceChangeBlocked || scheduleWorkspaceChangeBlocked
                    }
                    workspaceNavigationBlockedReason={
                      scheduleWorkspaceChangeBlocked
                        ? '请先确认当前日程写入，再切换工作区。'
                        : noteWorkspaceChangeBlocked
                          ? '请先确认当前笔记写入，再切换工作区。'
                          : null
                    }
                    focusSnapshot={focusController.snapshot}
                    focusStatus={focusController.status}
                    focusError={focusController.error}
                    focusOperation={focusController.operation}
                    focusRemainingSeconds={focusController.remainingSeconds}
                    focusSuccessSequence={focusSuccessSequence}
                    focusTaskCompletion={focusTaskCompletion}
                    focusTaskCompletionAction={focusTaskCompletionAction}
                    taskFocusStartUnavailableReason={taskFocusStartBlockReason}
                    onOpenInbox={() => requestActiveView('inbox')}
                    onOpenTasks={() => requestActiveView('tasks')}
                    onRetryTasks={taskController.retry}
                    onCreateTask={openTaskCreate}
                    onOpenTask={(task) =>
                      setTaskDialog({
                        mode: 'rename',
                        workspaceId: snapshot.currentWorkspaceId,
                        workspaceName: activeWorkspace.name,
                        task,
                      })
                    }
                    onUpdateTaskStatus={taskController.updateStatus}
                    onUpdateTaskPlanning={taskController.updatePlanning}
                    onRetrySchedule={scheduleController.retry}
                    onCreateSchedule={openScheduleCreate}
                    onOpenSchedule={openScheduleEdit}
                    onRetryFocus={focusController.retry}
                    onOpenFocus={openFocusDialog}
                    onPauseFocus={focusController.pause}
                    onResumeFocus={focusController.resume}
                    onCancelFocus={focusController.cancel}
                    onSwitchFocusWorkspace={requestWorkspaceActivation}
                    onCompleteFocusTask={completeFocusTask}
                    onDismissFocusTaskCompletion={dismissFocusTaskCompletion}
                    onOpenAssistant={() => openAssistant({ kind: 'today' })}
                  />
                ) : activeSurface === 'inbox' ? (
                  <InboxPage
                    key={
                      inboxReveal?.workspaceId === snapshot.currentWorkspaceId
                        ? `${snapshot.currentWorkspaceId}:${inboxReveal.generation}`
                        : snapshot.currentWorkspaceId
                    }
                    entries={inboxController.entries}
                    status={inboxController.status}
                    loadError={inboxController.loadError}
                    operationError={inboxController.operationError ?? noteController.operationError}
                    conversionFeedback={visibleInboxConversionFeedback}
                    conversionSyncWarning={visibleInboxConversionSyncWarning}
                    conversionFeedbackFocusBlocked={overlayOpen}
                    focusedConversionFeedbackKey={focusedInboxConversionFeedbackKey}
                    pendingEntryIds={inboxController.pendingEntryIds}
                    pendingConversionEntryIds={taskController.pendingConversionEntryIds}
                    pendingNoteConversionEntryIds={noteController.pendingConversionEntryIds}
                    conversionMutationPending={pendingInboxConversionIntents.has(
                      snapshot.currentWorkspaceId,
                    )}
                    requestedEntryId={
                      inboxReveal?.workspaceId === snapshot.currentWorkspaceId &&
                      !inboxReveal.handled
                        ? inboxReveal.entryId
                        : null
                    }
                    onRequestedEntryHandled={handleRequestedInboxEntry}
                    onRetry={inboxController.retry}
                    onOpenCapture={openQuickCapture}
                    onCategorize={inboxController.categorize}
                    onArchive={inboxController.archive}
                    onDismissConversionFeedback={(feedback) => {
                      if (inboxConversionFeedbackRef.current === feedback) {
                        inboxConversionFeedbackRef.current = null;
                      }
                      setInboxConversionFeedbackState((current) =>
                        current?.feedback === feedback ? null : current,
                      );
                    }}
                    onOpenConversionOutput={openInboxConversionOutput}
                    onRefreshConversionSyncWarning={async (feedback) => {
                      const warning = inboxConversionSyncWarningRef.current;
                      if (warning === null || warning.feedback !== feedback) {
                        throw new InboxConversionSupersededError();
                      }
                      await refreshInboxConversionSyncWarning(warning);
                    }}
                    onConversionFeedbackFocused={setFocusedInboxConversionFeedbackKey}
                    onOpenConvert={(entry) =>
                      setTaskDialog({
                        mode: 'convert',
                        workspaceId: snapshot.currentWorkspaceId,
                        workspaceName: activeWorkspace.name,
                        entry,
                        planning: 'day-0',
                      })
                    }
                    onConvertNote={convertInboxToNote}
                  />
                ) : activeSurface === 'tasks' ? (
                  <TaskPage
                    key={snapshot.currentWorkspaceId}
                    snapshot={taskController.snapshot}
                    tasks={taskController.tasks}
                    status={taskController.status}
                    loadError={taskController.loadError}
                    operationError={taskController.operationError}
                    pendingTaskIds={taskController.pendingTaskIds}
                    onRetry={taskController.retry}
                    onOpenCreate={() => openTaskCreate('none')}
                    onOpenRename={(task) =>
                      setTaskDialog({
                        mode: 'rename',
                        workspaceId: snapshot.currentWorkspaceId,
                        workspaceName: activeWorkspace.name,
                        task,
                      })
                    }
                    onUpdateStatus={taskController.updateStatus}
                    onUpdatePlanning={taskController.updatePlanning}
                    taskFocusStartUnavailableReason={taskFocusStartBlockReason}
                    onOpenFocus={openFocusDialog}
                    onOpenFocusStatus={() => requestActiveView('today')}
                    assistantTaskLimit={ASSISTANT_SELECTED_TASK_MAX_COUNT}
                    onOpenAssistant={(tasks) =>
                      openAssistant({
                        kind: 'tasks',
                        taskIds: tasks.map(({ id }) => id),
                      })
                    }
                  />
                ) : activeSurface === 'notes' ? (
                  <NotePage
                    key={`${snapshot.currentWorkspaceId}:${notePageGeneration}`}
                    workspaceName={activeWorkspace.name}
                    notes={noteController.notes}
                    status={noteController.status}
                    loadError={noteController.loadError}
                    operationError={noteController.operationError}
                    pendingNoteIds={noteController.pendingNoteIds}
                    pendingCreate={noteController.pendingCreate}
                    pendingMutation={
                      noteMutationCoordinator.isPending(snapshot.currentWorkspaceId) ||
                      noteWriteIsBlocked(noteCreateActivation) ||
                      noteController.pendingMutation ||
                      pendingInboxConversionIntents.get(snapshot.currentWorkspaceId)?.outputKind ===
                        'note'
                    }
                    pendingMutationMessage={externalNoteMutationBlockMessage}
                    requestedNoteId={requestedNoteId}
                    onRequestedNoteHandled={() => setRequestedNoteId(null)}
                    onDirtyChange={updateNoteDraftDirty}
                    onRetry={noteController.retry}
                    onCreate={createNote}
                    createSyncWarning={visibleNoteCreateSyncWarning}
                    onCreateSyncWarning={publishNoteCreateSyncWarning}
                    onCreateSyncResolved={resolveNoteCreateSyncWarning}
                    onRefreshCreated={recoverCreatedNote}
                    mutationSyncWarning={visibleNoteMutationSyncWarning}
                    mutationSyncWarningRefreshing={
                      visibleNoteMutationSyncWarning?.refreshing ?? false
                    }
                    mutationSyncWarningError={visibleNoteMutationSyncWarning?.refreshError ?? null}
                    focusMutationSyncWarningActionOnMount={
                      visibleNoteMutationSyncWarning?.focusActionOnMount ?? false
                    }
                    onMutationSyncWarning={publishNoteMutationSyncWarning}
                    onRefreshMutation={refreshNoteMutationSyncWarning}
                    onUpdate={updateNote}
                    onArchive={archiveNote}
                    onOpenLink={(url) => {
                      openUrlInWorkspace(snapshot.currentWorkspaceId, url);
                    }}
                    onOpenAssistant={(note) =>
                      openAssistant({
                        kind: 'note',
                        noteId: note.id,
                        revision: note.revision,
                      })
                    }
                  />
                ) : activeSurface === 'assistant' ? (
                  <AssistantPage
                    key={snapshot.currentWorkspaceId}
                    workspaceName={activeWorkspace.name}
                    credential={assistantController.credential}
                    credentialStatus={assistantController.credentialStatus}
                    credentialError={assistantController.credentialError}
                    runtimeStatus={assistantController.runtimeStatus}
                    runtimeError={assistantController.runtimeError}
                    runtime={assistantController.snapshot}
                    operation={
                      assistantController.operation === 'start' ||
                      assistantController.operation === 'cancel'
                        ? assistantController.operation
                        : null
                    }
                    notes={noteController.notes}
                    tasks={taskController.tasks}
                    initialContext={assistantInitialContext}
                    contextGeneration={assistantEntry.generation}
                    promptMaxLength={ASSISTANT_PROMPT_MAX_LENGTH}
                    onRetry={assistantController.retry}
                    onOpenSettings={openAssistantSettings}
                    onStart={startAssistantRequest}
                    onCancel={assistantController.cancel}
                    savedNote={currentAssistantSavedNote}
                    onSaveResponse={saveAssistantResponse}
                    onOpenSavedNote={openAssistantSavedNote}
                  />
                ) : activeSurface === 'settings' ? (
                  <SettingsPage
                    workspaceId={snapshot.currentWorkspaceId}
                    section={settingsSection}
                    onSectionChange={setSettingsSection}
                    onOpenBrowser={() => updatePreferences({ browserOpen: true })}
                    onOpenTerminal={() => updatePreferences({ terminalOpen: true })}
                    dataSnapshot={dataState.snapshot}
                    dataStatus={dataState.loadStatus}
                    dataOperation={dataState.activeOperation?.kind ?? null}
                    dataFeedback={dataState.feedback}
                    manualBackupBlocked={manualBackupBlocked}
                    onRetryData={() => void loadData()}
                    onCreateBackup={createBackup}
                    onRestoreBackup={restoreBackupWithApproval}
                    onUpdateBackupPolicy={updateBackupPolicy}
                    onExportData={exportData}
                    onChooseImport={chooseImport}
                    assistant={{
                      credential: assistantController.credential,
                      credentialStatus: assistantController.credentialStatus,
                      credentialError: assistantController.credentialError,
                      credentialOperation:
                        assistantController.operation === 'configure' ||
                        assistantController.operation === 'remove'
                          ? assistantController.operation
                          : null,
                      apiKeyMinLength: ASSISTANT_API_KEY_MIN_LENGTH,
                      apiKeyMaxLength: ASSISTANT_API_KEY_MAX_LENGTH,
                      onRetryCredential: assistantController.retry,
                      onConfigureCredential: assistantController.configureCredential,
                      onRemoveCredential: assistantController.removeCredential,
                    }}
                  />
                ) : (
                  <AutomationPage
                    items={automationController.items}
                    status={automationController.status}
                    loadError={automationController.loadError}
                    operationError={automationController.operationError}
                    runFeedback={visibleAutomationRunFeedback}
                    runSyncWarning={visibleAutomationRunSyncWarning}
                    runBlocked={automationRunBlocked}
                    runActivity={visibleAutomationRunActivity}
                    runSyncWarningRefreshing={visibleAutomationRunSyncWarningRefreshing}
                    runSyncWarningError={visibleAutomationRunSyncWarningError}
                    runSyncWarningFocusBlocked={overlayOpen}
                    focusRunSyncWarningAction={
                      currentAutomationRunPublication?.kind === 'warning' &&
                      currentAutomationRunPublication.focusActionOnMount
                    }
                    pendingItemIds={automationController.pendingItemIds}
                    runningItemIds={automationController.runningItemIds}
                    pendingCreate={automationController.pendingCreate}
                    onRetry={automationController.retry}
                    onOpenCreate={openAutomationCreate}
                    onOpenEdit={openAutomationEdit}
                    onSetEnabled={automationController.setEnabled}
                    onRunNow={runAutomationNow}
                    onOpenRunOutput={openAutomationRunOutput}
                    onRefreshRunSyncWarning={refreshAutomationRunSyncWarning}
                  />
                )}
              </div>
            </main>

            {browserOpen ? (
              <>
                <button
                  className="browser-scrim"
                  type="button"
                  aria-label="关闭浏览器面板"
                  onClick={() => updatePreferences({ browserOpen: false })}
                />
                <div className="browser-region" style={{ width: browserWidth }}>
                  <div
                    className="panel-resizer panel-resizer--horizontal"
                    role="separator"
                    aria-label="调整浏览器宽度"
                    aria-orientation="vertical"
                    aria-valuemin={340}
                    aria-valuemax={720}
                    aria-valuenow={browserWidth}
                    tabIndex={0}
                    onPointerDown={beginBrowserResize}
                    onKeyDown={(event) => {
                      if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
                        event.preventDefault();
                        updatePreferences({
                          browserWidth: clamp(
                            browserWidth + (event.key === 'ArrowLeft' ? 16 : -16),
                            340,
                            720,
                          ),
                        });
                      }
                    }}
                  />
                  <BrowserPanel
                    workspaceId={snapshot.currentWorkspaceId}
                    visible={!overlayOpen}
                    onClose={() => updatePreferences({ browserOpen: false })}
                  />
                </div>
              </>
            ) : null}
          </div>

          <div
            className={`terminal-region ${terminalOpen ? '' : 'is-collapsed'}`}
            style={{ height: terminalOpen ? effectiveTerminalHeight : 0 }}
            aria-hidden={!terminalOpen}
            inert={!terminalOpen}
          >
            <div
              className="panel-resizer panel-resizer--vertical"
              role="separator"
              aria-label="调整终端高度"
              aria-orientation="horizontal"
              aria-valuemin={180}
              aria-valuemax={terminalMaximum}
              aria-valuenow={effectiveTerminalHeight}
              tabIndex={terminalOpen ? 0 : -1}
              onPointerDown={beginTerminalResize}
              onKeyDown={(event) => {
                if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
                  event.preventDefault();
                  updatePreferences({
                    terminalHeight: clamp(
                      effectiveTerminalHeight + (event.key === 'ArrowUp' ? 16 : -16),
                      180,
                      terminalMaximum,
                    ),
                  });
                }
              }}
            />
            <TerminalPanel
              theme={theme}
              visible={terminalOpen}
              workspaceId={snapshot.currentWorkspaceId}
              onClose={() => updatePreferences({ terminalOpen: false })}
              onOpenSettings={openTerminalSettings}
              onMaximize={() =>
                updatePreferences({
                  terminalHeight:
                    effectiveTerminalHeight > viewportHeight * 0.6 ? 260 : terminalMaximum,
                })
              }
            />
          </div>

          <footer className="statusbar">
            <div>
              <span className="status-dot" />
              <span
                role={
                  statusbarErrorSource !== null && !statusbarErrorIsMirrored ? 'alert' : undefined
                }
              >
                {workspaceController.operationError ??
                  inboxController.operationError ??
                  taskController.operationError ??
                  noteController.operationError ??
                  scheduleController.operationError ??
                  automationController.operationError ??
                  assistantController.credentialError ??
                  assistantController.runtimeError ??
                  (dataState.feedback?.tone === 'error' ? dataState.feedback.message : null) ??
                  (noteDraftDirty ? '笔记有未保存的更改' : null) ??
                  '已就绪'}
              </span>
            </div>
            <div className="statusbar__context">
              <span>{activeWorkspace.name}</span>
              <span>本地数据</span>
            </div>
            <div>
              <button
                type="button"
                onClick={() => updatePreferences({ browserOpen: !browserOpen })}
              >
                <Globe2 size={12} /> 浏览器
              </button>
              <button
                type="button"
                onClick={() => updatePreferences({ terminalOpen: !terminalOpen })}
              >
                <SquareTerminal size={12} /> 终端
              </button>
              <span>v{appVersion}</span>
            </div>
          </footer>
        </div>
      </div>

      <CommandPalette
        open={paletteOpen}
        commands={commands}
        searchController={searchController}
        currentWorkspaceId={snapshot.currentWorkspaceId}
        onSelectSearchResult={selectSearchResult}
        onClose={() => setPaletteOpen(false)}
      />
      {archiveManager.open ? (
        <ArchivedWorkspacesDialog
          status={archiveManager.status}
          workspaces={archiveManager.workspaces}
          loadError={archiveManager.loadError}
          pendingWorkspaceId={
            workspaceController.pendingOperation === 'restore'
              ? workspaceController.pendingWorkspaceId
              : null
          }
          onClose={workspaceController.closeArchiveManager}
          onRetry={workspaceController.retryArchiveManager}
          onRestore={workspaceController.restore}
        />
      ) : null}
      {workspaceDialog ? (
        <WorkspaceDialog
          state={workspaceDialog}
          onClose={() => setWorkspaceDialog(null)}
          onCreate={createWorkspace}
          onRename={workspaceController.rename}
          onArchive={archiveWorkspace}
        />
      ) : null}
      {quickCaptureTarget ? (
        <QuickCaptureDialog
          target={quickCaptureTarget}
          onClose={closeQuickCaptureDialog}
          onSubmit={createInboxCapture}
        />
      ) : null}
      {taskDialog ? (
        <TaskDialog
          state={taskDialog}
          planningDays={taskController.snapshot?.planningDays ?? []}
          onClose={closeTaskDialog}
          onCreate={async (title, planning) => {
            if (taskDialog.workspaceId !== snapshot.currentWorkspaceId) {
              throw new Error('工作区已经切换，请重新打开任务窗口。');
            }
            await createManualTask(taskDialog.workspaceId, title, planning);
          }}
          onRename={async (taskId, title) => {
            if (taskDialog.workspaceId !== snapshot.currentWorkspaceId) {
              throw new Error('工作区已经切换，请重新打开任务窗口。');
            }
            await taskController.rename(taskId, title);
          }}
          onConvert={async (entryId, planning) => {
            if (taskDialog.workspaceId !== snapshot.currentWorkspaceId) {
              throw new Error('工作区已经切换，请重新打开任务窗口。');
            }
            if (taskDialog.mode !== 'convert' || taskDialog.entry.id !== entryId) {
              throw new Error('要转换的收件箱记录已经变化，请重新打开任务窗口。');
            }
            await convertInboxToTask(taskDialog.entry, planning);
          }}
        />
      ) : null}
      {scheduleDialog ? (
        <ScheduleDialog
          state={scheduleDialog}
          onClose={closeScheduleDialog}
          onCreate={async (title, kind, startMinute, endMinute) => {
            if (scheduleDialog.workspaceId !== snapshot.currentWorkspaceId) {
              throw new Error('工作区已经切换，请重新打开日程窗口。');
            }
            await createManualSchedule(
              scheduleDialog.workspaceId,
              scheduleDialog.expectedDate,
              title,
              kind,
              startMinute,
              endMinute,
            );
          }}
          onUpdate={async (item, title, kind, startMinute, endMinute) => {
            if (scheduleDialog.workspaceId !== snapshot.currentWorkspaceId) {
              throw new Error('工作区已经切换，请重新打开日程窗口。');
            }
            await updateSchedule(
              item,
              scheduleDialog.expectedDate,
              title,
              kind,
              startMinute,
              endMinute,
            );
          }}
          onArchive={async (item) => {
            if (scheduleDialog.workspaceId !== snapshot.currentWorkspaceId) {
              throw new Error('工作区已经切换，请重新打开日程窗口。');
            }
            await archiveSchedule(item, scheduleDialog.expectedDate);
          }}
        />
      ) : null}
      {automationDialog ? (
        <AutomationDialog
          state={automationDialog}
          onClose={() => setAutomationDialog(null)}
          onCreate={async (name, schedule, action) => {
            if (automationDialog.workspaceId !== snapshot.currentWorkspaceId) {
              throw new Error('工作区已经切换，请重新打开自动化窗口。');
            }
            await createManualAutomation(automationDialog.workspaceId, name, schedule, action);
          }}
          onUpdate={async (item, name, schedule, action) => {
            if (automationDialog.workspaceId !== snapshot.currentWorkspaceId) {
              throw new Error('工作区已经切换，请重新打开自动化窗口。');
            }
            await automationController.update(item, name, schedule, action);
          }}
          onArchive={async (item) => {
            if (automationDialog.workspaceId !== snapshot.currentWorkspaceId) {
              throw new Error('工作区已经切换，请重新打开自动化窗口。');
            }
            await automationController.archive(item);
          }}
        />
      ) : null}
      {focusDialogOpen && focusDialog ? (
        <FocusSessionDialog
          key={focusDialog.id}
          tasks={focusDialogTasks}
          initialTask={focusDialog.initialTask ?? undefined}
          startBlockedReason={focusStartBlockReason}
          taskOptionsUnavailableReason={focusTaskOptionsBlockReason}
          onClose={() =>
            setFocusDialog((current) => (current?.id === focusDialog.id ? null : current))
          }
          onStart={async (taskId) => {
            if (
              !isFocusDialogActivationCurrent(
                focusDialog.activation,
                focusActivation,
                snapshot.currentWorkspaceId,
              )
            ) {
              throw new Error('工作区已经切换，请重新打开专注窗口。');
            }
            if (focusStartBlockReason !== null) {
              throw new Error(focusStartBlockReason);
            }
            if (taskId !== undefined && !focusDialogTasks.some(({ id }) => id === taskId)) {
              throw new Error(
                '所选任务已完成、改期或不再可用。请选择另一项今日任务，或显式选择自由专注（不关联任务）。',
              );
            }
            await focusController.start(taskId);
          }}
          onStarted={() => {
            if (
              !isFocusDialogActivationCurrent(
                focusDialog.activation,
                focusActivation,
                snapshot.currentWorkspaceId,
              )
            ) {
              return;
            }
            requestActiveView('today');
            setFocusSuccessSequence((current) => current + 1);
          }}
        />
      ) : null}
      {dataState.importPreview ? (
        <DataImportDialog
          key={dataState.importPreview.importId}
          preview={dataState.importPreview}
          busy={dataState.activeOperation !== null}
          error={dataState.feedback?.tone === 'error' ? dataState.feedback.message : null}
          onCancel={cancelImport}
          onConfirm={async () => {
            if (noteMutationCoordinator.isPending(currentWorkspaceIdRef.current)) {
              throw new Error('笔记写入仍在确认，请稍候再导入数据。');
            }
            if (scheduleMutationCoordinator.isPending(currentWorkspaceIdRef.current)) {
              throw new Error('日程写入仍在确认，请稍候再导入数据。');
            }
            if (!confirmLeaveNoteDraft()) return;
            dataReplacementApprovedRef.current = true;
            dataReplacementNoteDiscardApprovedRef.current = true;
            try {
              await commitImport();
              invalidateWorkspacePreferenceEpoch();
              invalidateNoteMutations();
              invalidateScheduleMutations();
              invalidateManualBackupRecovery();
            } catch (error) {
              dataReplacementApprovedRef.current = false;
              dataReplacementNoteDiscardApprovedRef.current = false;
              throw error;
            }
          }}
        />
      ) : null}
      <InboxUndoStack
        notices={visibleUndoNotices}
        pendingTokens={inboxController.pendingUndoTokens}
        onUndo={inboxController.undoArchive}
        onDismiss={inboxController.dismissUndo}
      >
        {manualBackupSyncWarning ? (
          <BackupCreateSyncWarning
            backup={manualBackupSyncWarning.backup}
            focusActionOnMount={manualBackupSyncWarning.focusActionOnMount}
            focusBlocked={overlayOpen}
            blocked={dataState.activeOperation !== null}
            refreshing={manualBackupSyncWarning.refreshing}
            refreshError={manualBackupSyncWarning.refreshError}
            onRefresh={refreshManualBackupSyncWarning}
            onFocusFallback={restoreManualBackupSyncWarningFocus}
          />
        ) : null}
        {visibleAutomationCreateSyncWarning ? (
          <AutomationCreateSyncWarning
            name={visibleAutomationCreateSyncWarning.name}
            enabled={visibleAutomationCreateSyncWarning.enabled}
            message={visibleAutomationCreateSyncWarning.message}
            onRefresh={() => refreshAutomationCreateSyncWarning(visibleAutomationCreateSyncWarning)}
            onDismiss={() => dismissAutomationCreateSyncWarning(visibleAutomationCreateSyncWarning)}
          />
        ) : null}
        {visibleAutomationCreateFeedback ? (
          <AutomationCreateToast
            feedback={visibleAutomationCreateFeedback}
            focusBlocked={overlayOpen}
            onOpen={openCreatedAutomation}
            onDismiss={dismissAutomationCreate}
            onFocusFallback={restoreAutomationCreateFocus}
          />
        ) : null}
        {visibleScheduleCreateSyncWarning ? (
          <ScheduleCreateSyncWarning
            title={visibleScheduleCreateSyncWarning.title}
            scheduledFor={visibleScheduleCreateSyncWarning.scheduledFor}
            startMinute={visibleScheduleCreateSyncWarning.startMinute}
            endMinute={visibleScheduleCreateSyncWarning.endMinute}
            message={visibleScheduleCreateSyncWarning.message}
            blocked={scheduleWorkspaceChangeBlocked}
            blockedReason={
              scheduleWorkspaceChangeBlocked
                ? '请先完成当前日程写入的重新读取，再确认刚创建的日程。'
                : null
            }
            onRefresh={() => refreshScheduleCreateSyncWarning(visibleScheduleCreateSyncWarning)}
            onDismiss={() => dismissScheduleCreateSyncWarning(visibleScheduleCreateSyncWarning)}
          />
        ) : null}
        {visibleScheduleMutationSyncWarning ? (
          <ScheduleMutationSyncWarning
            kind={visibleScheduleMutationSyncWarning.kind}
            title={
              visibleScheduleMutationSyncWarning.kind === 'update'
                ? visibleScheduleMutationSyncWarning.intent.title
                : visibleScheduleMutationSyncWarning.intent.originalSchedule.title
            }
            scheduledFor={visibleScheduleMutationSyncWarning.intent.expectedDate}
            startMinute={
              visibleScheduleMutationSyncWarning.kind === 'update'
                ? visibleScheduleMutationSyncWarning.intent.startMinute
                : visibleScheduleMutationSyncWarning.intent.originalSchedule.startMinute
            }
            endMinute={
              visibleScheduleMutationSyncWarning.kind === 'update'
                ? visibleScheduleMutationSyncWarning.intent.endMinute
                : visibleScheduleMutationSyncWarning.intent.originalSchedule.endMinute
            }
            message={visibleScheduleMutationSyncWarning.message}
            focusActionOnMount={visibleScheduleMutationSyncWarning.focusActionOnMount}
            focusBlocked={overlayOpen}
            blocked={dataState.activeOperation !== null}
            blockedReason={
              dataState.activeOperation !== null
                ? '当前数据操作完成后，才能重新读取日程列表。'
                : null
            }
            refreshing={visibleScheduleMutationSyncWarning.refreshing}
            refreshError={visibleScheduleMutationSyncWarning.refreshError}
            onRefresh={async () => {
              await refreshScheduleMutationSyncWarning(visibleScheduleMutationSyncWarning);
            }}
            onFocusFallback={() =>
              restoreScheduleMutationWarningFocus(visibleScheduleMutationSyncWarning)
            }
          />
        ) : null}
        {visibleScheduleCreateFeedback ? (
          <ScheduleCreateToast
            feedback={visibleScheduleCreateFeedback}
            focusBlocked={overlayOpen}
            blocked={scheduleWorkspaceChangeBlocked}
            blockedReason={
              scheduleWorkspaceChangeBlocked
                ? '请先完成当前日程写入的重新读取，再编辑刚创建的日程。'
                : null
            }
            onOpen={openCreatedSchedule}
            onDismiss={dismissScheduleCreate}
            onFocusFallback={restoreScheduleCreateFocus}
          />
        ) : null}
        {visibleTaskCreateSyncWarning ? (
          <TaskCreateSyncWarning
            title={visibleTaskCreateSyncWarning.title}
            message={visibleTaskCreateSyncWarning.message}
            onDismiss={() =>
              dismissTaskCreateSyncWarning(visibleTaskCreateSyncWarning.requestGeneration)
            }
          />
        ) : null}
        {visibleTaskCreateFeedback ? (
          <TaskCreateToast
            feedback={visibleTaskCreateFeedback}
            focusBlocked={overlayOpen}
            onOpen={openManualTask}
            onDismiss={dismissTaskCreate}
            onFocusFallback={restoreTaskCreateFocus}
          />
        ) : null}
        {visibleInboxCaptureSyncWarning ? (
          <InboxCaptureSyncWarning
            content={visibleInboxCaptureSyncWarning.content}
            message={visibleInboxCaptureSyncWarning.message}
            focusActionOnMount={visibleInboxCaptureSyncWarning.focusActionOnMount}
            focusBlocked={overlayOpen}
            onRefresh={() => refreshInboxCaptureSyncWarning(visibleInboxCaptureSyncWarning)}
            onDismiss={() => dismissInboxCaptureSyncWarning(visibleInboxCaptureSyncWarning)}
          />
        ) : null}
        {visibleInboxCaptureFeedback ? (
          <InboxCaptureToast
            feedback={visibleInboxCaptureFeedback}
            focusBlocked={overlayOpen}
            onOpen={openInboxCapture}
            onDismiss={dismissInboxCapture}
            onFocusFallback={restoreInboxCaptureFocus}
          />
        ) : null}
      </InboxUndoStack>
    </div>
  );
}

interface StartupShellProps {
  status: 'loading' | 'ready' | 'error';
  error: string | null;
  canRetry: boolean;
  maximized: boolean;
  onRetry: () => void;
  onToggleMaximize: () => void;
}

function StartupShell({
  status,
  error,
  canRetry,
  maximized,
  onRetry,
  onToggleMaximize,
}: StartupShellProps) {
  return (
    <div className="app-shell" aria-busy={status === 'loading'}>
      <header className="titlebar">
        <div className="titlebar__identity">
          <span className="titlebar__logo">
            <Sparkles size={15} />
          </span>
          <strong>Daily Workbench</strong>
        </div>
        <span />
        <span />
        <WindowControls
          maximized={maximized}
          onToggleMaximize={onToggleMaximize}
          onClose={() => void window.workbench?.window.close()}
        />
      </header>
      <main className="workspace-startup">
        <span className="workspace-startup__logo">
          <Layers3 size={24} aria-hidden="true" />
        </span>
        {status === 'error' ? (
          <>
            <h1>工作区暂时无法打开</h1>
            <p role="alert">{error ?? '本地工作区初始化失败。'}</p>
            {canRetry ? (
              <button type="button" onClick={onRetry}>
                重试
              </button>
            ) : null}
          </>
        ) : (
          <>
            <h1>正在打开工作区</h1>
            <p>正在读取本地 SQLite 数据与布局设置…</p>
            <span className="workspace-startup__progress" aria-hidden="true" />
          </>
        )}
      </main>
    </div>
  );
}

interface WindowControlsProps {
  maximized: boolean;
  onToggleMaximize: () => void;
  onClose: () => void;
}

function WindowControls({ maximized, onToggleMaximize, onClose }: WindowControlsProps) {
  return (
    <div className="window-controls" aria-label="窗口控制">
      <button
        type="button"
        aria-label="最小化"
        onClick={() => void window.workbench?.window.minimize()}
      >
        <Minus size={15} />
      </button>
      <button type="button" aria-label={maximized ? '还原' : '最大化'} onClick={onToggleMaximize}>
        <Square size={12} />
      </button>
      <button type="button" className="window-controls__close" aria-label="关闭" onClick={onClose}>
        <X size={16} />
      </button>
    </div>
  );
}
