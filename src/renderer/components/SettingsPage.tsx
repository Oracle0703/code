import {
  Archive,
  CalendarClock,
  ChevronRight,
  Database,
  Download,
  FolderOpen,
  Globe2,
  HardDrive,
  KeyRound,
  LoaderCircle,
  MessageSquareText,
  RefreshCw,
  Settings2,
  ShieldCheck,
  SquareTerminal,
  Trash2,
  Upload,
} from 'lucide-react';
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
} from 'react';
import type {
  BackupCadence,
  BackupPolicy,
  BackupPolicyUpdateInput,
  BackupRunErrorCode,
  AssistantCredentialStatus,
  DataManagementSnapshot,
  DatabaseBackupInfo,
  DatabaseBackupRestoreInput,
  DatabaseBackupRestoreResult,
  TerminalProfileId,
  TerminalSnapshot,
} from '../../shared/contracts';
import {
  backupReasonLabel,
  dataOperationLabel,
  formatBackupBytes,
  formatBackupDateTime,
  latestDatabaseBackup,
  orderDatabaseBackups,
  type DataFeedback,
  type DataLoadStatus,
  type DataOperationKind,
} from '../data-state';
import { mergeTerminalSnapshot, terminalConfigurationIssue } from '../terminal-state';
import { BackupHistoryDialog, BackupRestoreDialog } from './BackupRestoreDialog';

export type SettingsSection =
  'general' | 'assistant' | 'terminal' | 'appearance' | 'data' | 'shortcuts' | 'about';

export type AssistantCredentialView = AssistantCredentialStatus;

export interface AssistantSettingsProps {
  readonly credential: AssistantCredentialView | null;
  readonly credentialStatus: 'loading' | 'ready' | 'error';
  readonly credentialError: string | null;
  readonly credentialOperation: 'configure' | 'remove' | null;
  readonly apiKeyMinLength: number;
  readonly apiKeyMaxLength: number;
  readonly onRetryCredential: () => void;
  readonly onConfigureCredential: (apiKey: string) => Promise<void>;
  readonly onRemoveCredential: () => Promise<void>;
}

interface SettingsPageProps {
  readonly workspaceId: string;
  readonly section?: SettingsSection;
  readonly defaultSection?: SettingsSection;
  readonly onSectionChange?: (section: SettingsSection) => void;
  readonly onOpenBrowser: () => void;
  readonly onOpenTerminal: () => void;
  readonly dataSnapshot: DataManagementSnapshot | null;
  readonly dataStatus: DataLoadStatus;
  readonly dataOperation: DataOperationKind | null;
  readonly dataFeedback: DataFeedback | null;
  readonly onRetryData: () => void;
  readonly onCreateBackup: () => void | Promise<void>;
  readonly onRestoreBackup: (
    input: DatabaseBackupRestoreInput,
  ) => Promise<DatabaseBackupRestoreResult | null>;
  readonly onUpdateBackupPolicy: (input: BackupPolicyUpdateInput) => void | Promise<void>;
  readonly onExportData: () => void | Promise<void>;
  readonly onChooseImport: () => void | Promise<void>;
  readonly assistant: AssistantSettingsProps;
}

const SETTINGS_SECTIONS: readonly { id: SettingsSection; label: string }[] = [
  { id: 'general', label: '通用' },
  { id: 'assistant', label: 'AI 助手' },
  { id: 'terminal', label: '终端' },
  { id: 'appearance', label: '外观' },
  { id: 'data', label: '数据' },
  { id: 'shortcuts', label: '快捷键' },
  { id: 'about', label: '关于' },
];

const WEEKDAY_OPTIONS = [
  '星期日',
  '星期一',
  '星期二',
  '星期三',
  '星期四',
  '星期五',
  '星期六',
] as const;

const BACKUP_ERROR_LABELS: Record<BackupRunErrorCode, string> = {
  'backup-failed': '无法创建一致性备份',
  'retention-failed': '备份已创建，但旧备份清理失败',
  'database-unavailable': '数据库暂时不可用',
};

export function SettingsPage({
  workspaceId,
  section,
  defaultSection = 'general',
  onSectionChange,
  onOpenBrowser,
  onOpenTerminal,
  dataSnapshot,
  dataStatus,
  dataOperation,
  dataFeedback,
  onRetryData,
  onCreateBackup,
  onRestoreBackup,
  onUpdateBackupPolicy,
  onExportData,
  onChooseImport,
  assistant,
}: SettingsPageProps) {
  const [internalSection, setInternalSection] = useState(defaultSection);
  const activeSection = section ?? internalSection;
  const busy = dataOperation !== null;
  const terminalController = useTerminalSettingsController(
    workspaceId,
    activeSection === 'terminal',
  );

  const selectSection = (nextSection: SettingsSection) => {
    if (section === undefined) setInternalSection(nextSection);
    onSectionChange?.(nextSection);
  };

  const moveSection = (
    event: KeyboardEvent<HTMLButtonElement>,
    currentSection: SettingsSection,
  ) => {
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const currentIndex = SETTINGS_SECTIONS.findIndex(({ id }) => id === currentSection);
    const nextIndex =
      event.key === 'Home'
        ? 0
        : event.key === 'End'
          ? SETTINGS_SECTIONS.length - 1
          : (currentIndex + (event.key === 'ArrowDown' ? 1 : -1) + SETTINGS_SECTIONS.length) %
            SETTINGS_SECTIONS.length;
    const nextSection = SETTINGS_SECTIONS[nextIndex].id;
    selectSection(nextSection);
    document.getElementById(`settings-tab-${nextSection}`)?.focus();
  };

  return (
    <div className="section-page settings-page">
      <header className="section-page__header">
        <div className="section-page__title">
          <span>
            <Settings2 size={20} aria-hidden="true" />
          </span>
          <div>
            <h1 tabIndex={-1}>设置</h1>
            <p>调整工作台、应用数据与工具偏好。</p>
          </div>
        </div>
      </header>

      <section className="settings-view">
        <div
          className="settings-nav"
          role="tablist"
          aria-label="设置分类"
          aria-orientation="vertical"
        >
          {SETTINGS_SECTIONS.map(({ id, label }) => (
            <button
              id={`settings-tab-${id}`}
              type="button"
              role="tab"
              aria-selected={activeSection === id}
              aria-controls={`settings-panel-${id}`}
              tabIndex={activeSection === id ? 0 : -1}
              className={activeSection === id ? 'is-active' : ''}
              key={id}
              onClick={() => selectSection(id)}
              onKeyDown={(event) => moveSection(event, id)}
            >
              {label}
            </button>
          ))}
        </div>

        <div
          id={`settings-panel-${activeSection}`}
          className="settings-content"
          role="tabpanel"
          aria-labelledby={`settings-tab-${activeSection}`}
        >
          {activeSection === 'general' ? (
            <GeneralSettings onOpenBrowser={onOpenBrowser} onOpenTerminal={onOpenTerminal} />
          ) : null}
          {activeSection === 'terminal' ? (
            <TerminalSettings controller={terminalController} onOpenTerminal={onOpenTerminal} />
          ) : null}
          {activeSection === 'assistant' ? <AssistantSettings {...assistant} /> : null}
          {activeSection === 'appearance' ? <AppearanceSettings /> : null}
          {activeSection === 'data' ? (
            <DataSettings
              snapshot={dataSnapshot}
              status={dataStatus}
              operation={dataOperation}
              feedback={dataFeedback}
              onRetry={onRetryData}
              onCreateBackup={onCreateBackup}
              onRestoreBackup={onRestoreBackup}
              onUpdatePolicy={onUpdateBackupPolicy}
              onExport={onExportData}
              onChooseImport={onChooseImport}
            />
          ) : null}
          {activeSection === 'shortcuts' ? <ShortcutSettings /> : null}
          {activeSection === 'about' ? <AboutSettings /> : null}
        </div>
      </section>

      <p className="sr-only" role="status" aria-live="polite" aria-atomic="true">
        {activeSection === 'assistant' && assistant.credentialOperation
          ? assistant.credentialOperation === 'configure'
            ? '正在安全保存 OpenAI API 密钥。'
            : '正在移除 OpenAI API 密钥。'
          : terminalController.operation
            ? terminalOperationLabel(terminalController.operation)
            : busy
              ? dataOperationLabel(dataOperation)
              : (terminalController.feedback?.message ?? dataFeedback?.message ?? '')}
      </p>
    </div>
  );
}

export function AssistantSettings({
  credential,
  credentialStatus,
  credentialError,
  credentialOperation,
  apiKeyMinLength,
  apiKeyMaxLength,
  onRetryCredential,
  onConfigureCredential,
  onRemoveCredential,
}: AssistantSettingsProps) {
  const [apiKey, setApiKey] = useState('');
  const [feedback, setFeedback] = useState<string | null>(null);
  const keyInputRef = useRef<HTMLInputElement>(null);
  const keyLength = Array.from(apiKey).length;
  const busy = credentialOperation !== null;
  const keyInvalid = keyLength > 0 && keyLength < apiKeyMinLength;
  const removable = credential?.removable ?? false;

  useEffect(
    () => () => {
      if (keyInputRef.current) keyInputRef.current.value = '';
    },
    [],
  );

  const configure = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (
      keyLength < apiKeyMinLength ||
      keyLength > apiKeyMaxLength ||
      busy ||
      credential?.availability !== 'available'
    ) {
      return;
    }
    setFeedback(null);
    try {
      await onConfigureCredential(apiKey);
      setApiKey('');
      setFeedback('OpenAI API 密钥已安全保存。');
    } catch (error) {
      setFeedback(error instanceof Error ? error.message : '密钥未能保存，请重试。');
    }
  };

  const remove = async () => {
    if (busy || !removable) return;
    const confirmation =
      credential?.availability === 'unavailable'
        ? '删除这份本机 OpenAI 凭据？即使当前无法解密，凭据文件也会从设备移除。'
        : '移除 OpenAI API 密钥？AI 助手会立即停止接受新问题。';
    if (!window.confirm(confirmation)) return;
    setFeedback(null);
    try {
      await onRemoveCredential();
      setApiKey('');
      setFeedback('OpenAI API 密钥已移除。');
    } catch (error) {
      setFeedback(error instanceof Error ? error.message : '密钥未能移除，请重试。');
    }
  };

  if (credentialStatus === 'loading') {
    return (
      <div className="assistant-settings-state" role="status" aria-busy="true">
        <LoaderCircle className="is-spinning" size={20} aria-hidden="true" />
        <div>
          <strong>正在检查 AI 配置</strong>
          <p>已保存的密钥不会从 Main 回读；提交成功后输入框会立即清空。</p>
        </div>
      </div>
    );
  }

  if (credentialStatus === 'error' || !credential) {
    return (
      <div className="assistant-settings-state is-error" role="alert">
        <MessageSquareText size={20} aria-hidden="true" />
        <div>
          <strong>无法读取 AI 配置</strong>
          <p>{credentialError ?? '桌面安全存储暂时不可用。'}</p>
          <button type="button" className="secondary-button" onClick={onRetryCredential}>
            重新检查
          </button>
        </div>
      </div>
    );
  }

  if (credential.availability === 'unavailable') {
    const unavailableCopy =
      credential.reason === 'plaintext-storage'
        ? {
            title: '操作系统只提供明文凭据后端',
            body: 'AI 助手拒绝降级保存密钥。请启用系统密钥环后重新启动应用。',
          }
        : {
            title: '操作系统安全存储不可用',
            body: 'AI 助手保持停用，不会把密钥保存到明文文件或工作区数据库。',
          };
    return (
      <div className="assistant-settings-state is-error" role="alert">
        <ShieldCheck size={20} aria-hidden="true" />
        <div>
          <strong>{unavailableCopy.title}</strong>
          <p>{unavailableCopy.body}</p>
          {removable ? (
            <button
              type="button"
              className="danger-button"
              disabled={busy}
              onClick={() => void remove()}
            >
              {credentialOperation === 'remove' ? (
                <LoaderCircle className="is-spinning" size={14} aria-hidden="true" />
              ) : (
                <Trash2 size={14} aria-hidden="true" />
              )}
              {credentialOperation === 'remove' ? '删除中…' : '删除本机凭据'}
            </button>
          ) : null}
          {feedback ? (
            <p
              className="assistant-settings-feedback"
              role={feedback.includes('未能') ? 'alert' : 'status'}
            >
              {feedback}
            </p>
          ) : null}
        </div>
      </div>
    );
  }

  return (
    <>
      <div className="settings-group assistant-settings">
        <h2>OpenAI 连接</h2>
        <p>
          AI 请求会把你明确选择的上下文发送给 {credential.provider}；模型为 {credential.model}。
        </p>
        <p>OpenAI API 用量单独计费，不包含在 ChatGPT 订阅中。</p>
        <div className="assistant-credential-summary">
          <span className={credential.configured ? 'is-configured' : ''}>
            <KeyRound size={17} aria-hidden="true" />
          </span>
          <div>
            <strong>
              {credential.reason === 'credential-corrupt'
                ? '已保存的 API 密钥无法解密'
                : credential.configured
                  ? 'API 密钥已配置'
                  : '尚未配置 API 密钥'}
            </strong>
            <small>
              {credential.reason === 'credential-corrupt'
                ? '请保存新的密钥，或移除这份损坏的凭据。'
                : '密钥会从受信任设置页临时提交，并仅由桌面主进程持久化到操作系统安全存储；不会写入工作区 SQLite。'}
            </small>
          </div>
          {removable ? (
            <button
              type="button"
              className="danger-button"
              disabled={busy}
              onClick={() => void remove()}
            >
              {credentialOperation === 'remove' ? (
                <LoaderCircle className="is-spinning" size={14} aria-hidden="true" />
              ) : (
                <Trash2 size={14} aria-hidden="true" />
              )}
              {credentialOperation === 'remove' ? '移除中…' : '移除'}
            </button>
          ) : null}
        </div>

        <form className="assistant-key-form" onSubmit={(event) => void configure(event)}>
          <label htmlFor="assistant-api-key">
            {credential.configured ? '替换 API 密钥' : 'OpenAI API 密钥'}
          </label>
          <div>
            <input
              id="assistant-api-key"
              ref={keyInputRef}
              type="password"
              value={apiKey}
              disabled={busy}
              autoComplete="off"
              autoCapitalize="none"
              spellCheck={false}
              minLength={apiKeyMinLength}
              maxLength={apiKeyMaxLength}
              aria-invalid={keyInvalid}
              aria-describedby={keyInvalid ? 'assistant-api-key-help' : undefined}
              placeholder="sk-…"
              onChange={(event) => setApiKey(event.target.value)}
            />
            <button
              type="submit"
              className="primary-button"
              disabled={keyLength < apiKeyMinLength || keyLength > apiKeyMaxLength || busy}
            >
              {credentialOperation === 'configure' ? (
                <LoaderCircle className="is-spinning" size={14} aria-hidden="true" />
              ) : (
                <ShieldCheck size={14} aria-hidden="true" />
              )}
              {credentialOperation === 'configure' ? '保存中…' : '安全保存'}
            </button>
          </div>
          {keyInvalid ? (
            <small id="assistant-api-key-help" className="is-error">
              API 密钥至少需要 {apiKeyMinLength} 个字符。
            </small>
          ) : null}
        </form>
      </div>

      <div className="settings-group">
        <h2>发送边界</h2>
        <p>AI 助手不会自动读取整个工作区，也不会执行工具或更改本地数据。</p>
        <div className="assistant-boundary-list">
          <span>每次发送前显示所选上下文</span>
          <span>链接仅以文本显示，不会自动打开</span>
          <span>只有点击“保存为笔记”才会写入 SQLite</span>
        </div>
      </div>

      {feedback ? (
        <p
          className="assistant-settings-feedback"
          role={feedback.includes('未能') ? 'alert' : 'status'}
        >
          {feedback}
        </p>
      ) : null}
    </>
  );
}

function GeneralSettings({
  onOpenBrowser,
  onOpenTerminal,
}: Pick<SettingsPageProps, 'onOpenBrowser' | 'onOpenTerminal'>) {
  return (
    <>
      <div className="settings-group">
        <h2>工具面板</h2>
        <p>打开最常用的工作区工具。</p>
        <button type="button" className="setting-row" onClick={onOpenBrowser}>
          <span>
            <Globe2 size={17} aria-hidden="true" />
          </span>
          <div>
            <strong>内置浏览器</strong>
            <small>在右侧打开网页并保留当前工作上下文</small>
          </div>
          <ChevronRight size={16} aria-hidden="true" />
        </button>
        <button type="button" className="setting-row" onClick={onOpenTerminal}>
          <span>
            <SquareTerminal size={17} aria-hidden="true" />
          </span>
          <div>
            <strong>集成终端</strong>
            <small>使用 PowerShell、CMD、WSL 或其他 Shell</small>
          </div>
          <ChevronRight size={16} aria-hidden="true" />
        </button>
      </div>
      <div className="settings-group">
        <h2>启动</h2>
        <p>Daily Workbench 打开时恢复上次工作状态。</p>
        <div className="setting-row setting-row--static">
          <span>
            <Settings2 size={17} aria-hidden="true" />
          </span>
          <div>
            <strong>恢复工作区</strong>
            <small>面板尺寸、当前页面和工具会自动恢复</small>
          </div>
          <span className="settings-static-value">已启用</span>
        </div>
      </div>
    </>
  );
}

type TerminalSettingsStatus = 'idle' | 'loading' | 'ready' | 'error';
type TerminalSettingsOperation =
  'profile' | 'working-directory' | 'working-directory-reset' | 'wsl' | 'refresh' | 'create';

interface TerminalSettingsFeedback {
  readonly tone: 'success' | 'error' | 'info';
  readonly message: string;
}

interface TerminalSettingsController {
  readonly snapshot: TerminalSnapshot | null;
  readonly status: TerminalSettingsStatus;
  readonly error: string | null;
  readonly feedback: TerminalSettingsFeedback | null;
  readonly operation: TerminalSettingsOperation | null;
  retry(): void;
  updateProfile(profileId: TerminalProfileId): Promise<void>;
  chooseWorkingDirectory(): Promise<void>;
  resetWorkingDirectory(): Promise<void>;
  updateWslDistribution(distributionId: string | null): Promise<void>;
  refreshCapabilities(): Promise<void>;
  createTerminal(): Promise<boolean>;
}

function useTerminalSettingsController(
  workspaceId: string,
  active: boolean,
): TerminalSettingsController {
  const terminalApi = window.workbench?.terminal;
  const [stateWorkspaceId, setStateWorkspaceId] = useState(workspaceId);
  const [snapshot, setSnapshot] = useState<TerminalSnapshot | null>(null);
  const [status, setStatus] = useState<TerminalSettingsStatus>('idle');
  const [error, setError] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<TerminalSettingsFeedback | null>(null);
  const [operation, setOperation] = useState<TerminalSettingsOperation | null>(null);
  const [loadGeneration, setLoadGeneration] = useState(0);
  const snapshotRef = useRef<TerminalSnapshot | null>(null);
  const requestGenerationRef = useRef(0);
  const actionGenerationRef = useRef(0);
  const operationInFlightRef = useRef(false);

  const applySnapshot = useCallback(
    (incoming: TerminalSnapshot): void => {
      if (incoming.workspaceId !== workspaceId) return;
      const current = snapshotRef.current;
      const next =
        current?.workspaceId === incoming.workspaceId
          ? (mergeTerminalSnapshot(new Map([[incoming.workspaceId, current]]), incoming).get(
              incoming.workspaceId,
            ) ?? current)
          : incoming;
      snapshotRef.current = next;
      setStateWorkspaceId(incoming.workspaceId);
      setSnapshot(next);
      setStatus('ready');
    },
    [workspaceId],
  );

  useEffect(() => {
    const generation = ++requestGenerationRef.current;
    actionGenerationRef.current += 1;
    operationInFlightRef.current = false;
    snapshotRef.current = null;
    queueMicrotask(() => {
      if (requestGenerationRef.current !== generation) return;
      setStateWorkspaceId(workspaceId);
      setSnapshot(null);
      setOperation(null);
      setFeedback(null);
      if (!active) {
        setStatus('idle');
        setError(null);
      } else if (!terminalApi) {
        setStatus('error');
        setError('桌面终端桥接不可用，请重新启动应用。');
      } else {
        setStatus('loading');
        setError(null);
      }
    });
    if (!active) {
      return;
    }
    if (!terminalApi) {
      return;
    }

    const unsubscribe = terminalApi.onStateChange((incoming) => {
      if (requestGenerationRef.current !== generation) return;
      applySnapshot(incoming);
    });
    void terminalApi
      .getSnapshot({ workspaceId })
      .then((incoming) => {
        if (requestGenerationRef.current !== generation) return;
        applySnapshot(incoming);
        setError(null);
      })
      .catch(() => {
        if (requestGenerationRef.current !== generation) return;
        setStatus('error');
        setError('无法读取当前工作区的终端设置。');
      });

    return () => {
      if (requestGenerationRef.current === generation) requestGenerationRef.current += 1;
      unsubscribe();
    };
  }, [active, applySnapshot, loadGeneration, terminalApi, workspaceId]);

  const runAction = useCallback(
    async (
      kind: TerminalSettingsOperation,
      action: () => Promise<{
        readonly snapshot: TerminalSnapshot;
        readonly feedback: TerminalSettingsFeedback;
      }>,
    ): Promise<boolean> => {
      if (!terminalApi || operationInFlightRef.current) return false;
      const generation = ++actionGenerationRef.current;
      operationInFlightRef.current = true;
      setOperation(kind);
      setStateWorkspaceId(workspaceId);
      setError(null);
      setFeedback(null);
      try {
        const result = await action();
        if (actionGenerationRef.current !== generation) return false;
        applySnapshot(result.snapshot);
        setFeedback(result.feedback);
        return true;
      } catch {
        if (actionGenerationRef.current !== generation) return false;
        setError('终端设置未能保存；配置可能已经变化，请重试。');
        void terminalApi
          .getSnapshot({ workspaceId })
          .then(applySnapshot)
          .catch(() => undefined);
        return false;
      } finally {
        if (actionGenerationRef.current === generation) {
          operationInFlightRef.current = false;
          setOperation(null);
        }
      }
    },
    [applySnapshot, terminalApi, workspaceId],
  );

  const requireSnapshot = (): TerminalSnapshot | null => {
    const current = snapshotRef.current;
    return current?.workspaceId === workspaceId ? current : null;
  };

  const stateMatchesWorkspace = stateWorkspaceId === workspaceId;

  return {
    snapshot: stateMatchesWorkspace ? snapshot : null,
    status: stateMatchesWorkspace ? status : active ? 'loading' : 'idle',
    error: stateMatchesWorkspace ? error : null,
    feedback: stateMatchesWorkspace ? feedback : null,
    operation: stateMatchesWorkspace ? operation : null,
    retry: () => setLoadGeneration((generation) => generation + 1),
    updateProfile: async (profileId) => {
      const current = requireSnapshot();
      if (!terminalApi || !current) return;
      const profile = current.profiles.find(({ id }) => id === profileId);
      if (!profile?.available) return;
      await runAction('profile', async () => ({
        snapshot: await terminalApi.updateProfile({
          workspaceId,
          profileId,
          expectedRevision: current.configuration.revision,
        }),
        feedback: {
          tone: 'success',
          message: `默认终端已设为 ${profile.label}；现有会话不会改变。`,
        },
      }));
    },
    chooseWorkingDirectory: async () => {
      const current = requireSnapshot();
      if (!terminalApi || !current) return;
      await runAction('working-directory', async () => {
        const selection = await terminalApi.chooseWorkingDirectory({
          workspaceId,
          expectedRevision: current.configuration.revision,
        });
        return {
          snapshot: selection.snapshot,
          feedback:
            selection.status === 'cancelled'
              ? { tone: 'info', message: '已取消选择，启动目录没有改变。' }
              : {
                  tone: 'success',
                  message: '新的启动目录已保存；现有会话不会改变。',
                },
        };
      });
    },
    resetWorkingDirectory: async () => {
      const current = requireSnapshot();
      if (!terminalApi || !current) return;
      await runAction('working-directory-reset', async () => ({
        snapshot: await terminalApi.resetWorkingDirectory({
          workspaceId,
          expectedRevision: current.configuration.revision,
        }),
        feedback: {
          tone: 'success',
          message: '新终端将从对应 Profile 的主目录启动。',
        },
      }));
    },
    updateWslDistribution: async (distributionId) => {
      const current = requireSnapshot();
      if (!terminalApi || !current) return;
      await runAction('wsl', async () => ({
        snapshot: await terminalApi.updateWslDistribution({
          workspaceId,
          distributionId,
          expectedRevision: current.configuration.revision,
          capabilityRevision: current.configuration.wsl.capabilityRevision,
        }),
        feedback: {
          tone: 'success',
          message:
            distributionId === null
              ? 'WSL 已设为跟随系统默认发行版。'
              : 'WSL 发行版偏好已保存；现有会话不会改变。',
        },
      }));
    },
    refreshCapabilities: async () => {
      if (!terminalApi) return;
      await runAction('refresh', async () => ({
        snapshot: await terminalApi.refreshCapabilities({ workspaceId }),
        feedback: { tone: 'success', message: '已重新检测本机 Shell 与 WSL 能力。' },
      }));
    },
    createTerminal: async () => {
      const current = requireSnapshot();
      if (!terminalApi || !current || terminalConfigurationIssue(current)) return false;
      return runAction('create', async () => ({
        snapshot: await terminalApi.create({
          workspaceId,
          configurationRevision: current.configuration.revision,
        }),
        feedback: { tone: 'success', message: '已使用当前设置新建终端。' },
      }));
    },
  };
}

function TerminalSettings({
  controller,
  onOpenTerminal,
}: {
  readonly controller: TerminalSettingsController;
  readonly onOpenTerminal: () => void;
}) {
  if (controller.status === 'idle' || controller.status === 'loading') {
    return (
      <div className="terminal-settings-state" role="status" aria-busy="true">
        <RefreshCw className="is-spinning" size={22} aria-hidden="true" />
        <strong>正在读取终端设置</strong>
        <p>正在检查当前工作区的 Profile、启动目录与 WSL 能力…</p>
      </div>
    );
  }
  if (controller.status === 'error' || !controller.snapshot) {
    return (
      <div className="terminal-settings-state is-error" role="alert">
        <SquareTerminal size={22} aria-hidden="true" />
        <strong>无法读取终端设置</strong>
        <p>{controller.error ?? '请重试；现有终端会话不会改变。'}</p>
        <button type="button" className="secondary-button" onClick={controller.retry}>
          重新加载
        </button>
      </div>
    );
  }

  const { snapshot } = controller;
  const { configuration } = snapshot;
  const busy = controller.operation !== null;
  const configurationError = terminalConfigurationIssue(snapshot);
  const selectedWslMissing =
    configuration.wsl.selectedDistributionId !== null &&
    !configuration.wsl.distributions.some(
      ({ id }) => id === configuration.wsl.selectedDistributionId,
    );

  return (
    <div className="terminal-settings" aria-busy={busy}>
      <div className="settings-group">
        <h2>当前工作区终端</h2>
        <p>以下设置只影响当前工作区中新建的会话；正在运行或已经退出的会话保持原启动配置。</p>
        {controller.error ? (
          <p className="terminal-settings-feedback is-error" role="alert">
            {controller.error}
          </p>
        ) : null}
        {controller.feedback ? (
          <p
            className={`terminal-settings-feedback is-${controller.feedback.tone}`}
            role={controller.feedback.tone === 'error' ? 'alert' : 'status'}
          >
            {controller.feedback.message}
          </p>
        ) : null}
        {busy ? (
          <p className="terminal-settings-operation" role="status">
            <RefreshCw className="is-spinning" size={14} aria-hidden="true" />
            {terminalOperationLabel(controller.operation)}
          </p>
        ) : null}
      </div>

      <div className="settings-group">
        <h2 id="terminal-profile-heading">默认 Profile</h2>
        <p>工具栏与命令中心新建终端时使用这一 Profile。</p>
        <label className="terminal-settings-field">
          <span>新终端 Profile</span>
          <select
            value={configuration.preferredProfileId}
            disabled={busy}
            aria-describedby="terminal-profile-help"
            onChange={(event) =>
              void controller.updateProfile(event.target.value as TerminalProfileId)
            }
          >
            {snapshot.profiles.map(({ id, label, available, unavailableReason }) => (
              <option key={id} value={id} disabled={!available}>
                {label}
                {available ? '' : ` · ${unavailableReason ?? '不可用'}`}
              </option>
            ))}
          </select>
        </label>
        <p id="terminal-profile-help" className="terminal-settings-hint">
          不支持自定义可执行文件、参数或环境变量。
        </p>
      </div>

      <div className="settings-group">
        <h2>启动目录</h2>
        <p>本机 Shell 使用用户主目录或由系统选择器授权的文件夹；没有可编辑路径输入。</p>
        <div
          className={`terminal-directory-card ${
            configuration.workingDirectory.available ? '' : 'is-error'
          }`}
        >
          <span>
            <FolderOpen size={17} aria-hidden="true" />
          </span>
          <div>
            <strong>
              {configuration.workingDirectory.mode === 'user-home'
                ? 'Profile 主目录'
                : '选择的文件夹'}
            </strong>
            <small title={configuration.workingDirectory.displayPath}>
              {configuration.workingDirectory.displayPath}
            </small>
            {!configuration.workingDirectory.available ? (
              <small role="alert">
                {configuration.workingDirectory.unavailableReason ?? '这个目录当前不可用。'}
              </small>
            ) : null}
          </div>
          <div className="terminal-directory-actions">
            <button
              type="button"
              className="secondary-button"
              disabled={busy}
              onClick={() => void controller.chooseWorkingDirectory()}
            >
              {configuration.workingDirectory.mode === 'user-home' ? '选择文件夹…' : '重新选择…'}
            </button>
            {configuration.workingDirectory.mode === 'selected-directory' ? (
              <button
                type="button"
                className="secondary-button"
                disabled={busy}
                onClick={() => void controller.resetWorkingDirectory()}
              >
                改用主目录
              </button>
            ) : null}
          </div>
        </div>
      </div>

      <div className="settings-group">
        <div className="settings-group__heading">
          <div>
            <h2>Windows Subsystem for Linux</h2>
            <p>WSL 会从所选发行版的 Linux 主目录启动。</p>
          </div>
          {configuration.wsl.status !== 'unsupported' ? (
            <button
              type="button"
              className="secondary-button"
              disabled={busy}
              onClick={() => void controller.refreshCapabilities()}
            >
              <RefreshCw size={14} aria-hidden="true" /> 重新检测
            </button>
          ) : null}
        </div>
        {configuration.wsl.status === 'unsupported' ? (
          <p className="terminal-wsl-state" role="status">
            当前平台不提供 WSL；可使用系统 Shell、Bash、Zsh 或 PowerShell。
          </p>
        ) : configuration.wsl.status === 'ready' ? (
          <>
            <label className="terminal-settings-field">
              <span>新 WSL 会话</span>
              <select
                value={configuration.wsl.selectedDistributionId ?? ''}
                disabled={busy}
                onChange={(event) =>
                  void controller.updateWslDistribution(event.target.value || null)
                }
              >
                <option value="">跟随系统默认发行版</option>
                {selectedWslMissing && configuration.wsl.selectedDistributionId ? (
                  <option value={configuration.wsl.selectedDistributionId} disabled>
                    {configuration.wsl.selectedDistributionLabel ?? '已保存的发行版'} · 不可用
                  </option>
                ) : null}
                {configuration.wsl.distributions.map(({ id, label }) => (
                  <option key={id} value={id}>
                    {label}
                  </option>
                ))}
              </select>
            </label>
            {!configuration.wsl.selectedDistributionAvailable ? (
              <p className="terminal-wsl-state is-error" role="alert">
                当前选择不可用，请选择检测到的发行版或重新检测。
              </p>
            ) : null}
          </>
        ) : (
          <p
            className={`terminal-wsl-state ${
              configuration.wsl.status === 'probe-error' ? 'is-error' : ''
            }`}
            role={configuration.wsl.status === 'probe-error' ? 'alert' : 'status'}
          >
            {wslCapabilityMessage(configuration.wsl.status)}
          </p>
        )}
      </div>

      <div className="settings-group">
        <h2>验证设置</h2>
        <p>创建一个新会话来确认 Profile、启动目录与 WSL 选择。</p>
        {configurationError ? (
          <p className="terminal-wsl-state is-error" role="alert">
            {configurationError}
          </p>
        ) : null}
        <button
          type="button"
          className="secondary-button"
          disabled={busy || Boolean(configurationError)}
          onClick={() => {
            void controller.createTerminal().then((created) => {
              if (created) onOpenTerminal();
            });
          }}
        >
          <SquareTerminal size={14} aria-hidden="true" /> 使用当前设置新建终端
        </button>
      </div>
    </div>
  );
}

function terminalOperationLabel(operation: TerminalSettingsOperation | null): string {
  switch (operation) {
    case 'profile':
      return '正在保存默认 Profile…';
    case 'working-directory':
      return '正在选择启动目录…';
    case 'working-directory-reset':
      return '正在恢复主目录…';
    case 'wsl':
      return '正在保存 WSL 发行版…';
    case 'refresh':
      return '正在重新检测本机终端能力…';
    case 'create':
      return '正在创建终端…';
    default:
      return '';
  }
}

function wslCapabilityMessage(status: TerminalSnapshot['configuration']['wsl']['status']): string {
  switch (status) {
    case 'not-installed':
      return '本机尚未启用 Windows Subsystem for Linux。';
    case 'no-distributions':
      return '已检测到 WSL，但尚无可启动的发行版。';
    case 'probe-error':
      return '暂时无法读取 WSL 发行版；现有设置没有改变。';
    default:
      return '';
  }
}

function AppearanceSettings() {
  return (
    <div className="settings-group">
      <h2>工作区外观</h2>
      <p>主题仍按工作区保存，可从标题栏或命令中心快速切换。</p>
      <div className="setting-row setting-row--static">
        <span>
          <Settings2 size={17} aria-hidden="true" />
        </span>
        <div>
          <strong>当前工作区主题</strong>
          <small>使用标题栏的主题按钮切换深色或浅色模式</small>
        </div>
      </div>
    </div>
  );
}

interface DataSettingsProps {
  readonly snapshot: DataManagementSnapshot | null;
  readonly status: DataLoadStatus;
  readonly operation: DataOperationKind | null;
  readonly feedback: DataFeedback | null;
  readonly onRetry: () => void;
  readonly onCreateBackup: () => void | Promise<void>;
  readonly onRestoreBackup: (
    input: DatabaseBackupRestoreInput,
  ) => Promise<DatabaseBackupRestoreResult | null>;
  readonly onUpdatePolicy: (input: BackupPolicyUpdateInput) => void | Promise<void>;
  readonly onExport: () => void | Promise<void>;
  readonly onChooseImport: () => void | Promise<void>;
}

export function DataSettings({
  snapshot,
  status,
  operation,
  feedback,
  onRetry,
  onCreateBackup,
  onRestoreBackup,
  onUpdatePolicy,
  onExport,
  onChooseImport,
}: DataSettingsProps) {
  const actionInFlightRef = useRef(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [restoreTarget, setRestoreTarget] = useState<DatabaseBackupInfo | null>(null);
  const runAction = async (action: () => void | Promise<void>): Promise<void> => {
    if (operation !== null || actionInFlightRef.current) return;
    actionInFlightRef.current = true;
    try {
      await action();
    } finally {
      actionInFlightRef.current = false;
    }
  };

  if (status === 'loading' || status === 'idle') {
    return (
      <div className="settings-data-state" role="status">
        <RefreshCw className="is-spinning" size={22} aria-hidden="true" />
        <strong>正在读取本地数据状态</strong>
        <p>正在检查 SQLite、备份与定时策略…</p>
      </div>
    );
  }
  if (status === 'error' || !snapshot) {
    return (
      <div className="settings-data-state is-error" role="alert">
        <Database size={22} aria-hidden="true" />
        <strong>无法读取数据管理状态</strong>
        <p>{feedback?.message ?? '请重试；现有数据不会因此被更改。'}</p>
        <button type="button" className="secondary-button" onClick={onRetry}>
          重新加载
        </button>
      </div>
    );
  }

  const busy = operation !== null;
  const latestBackup = latestDatabaseBackup(snapshot.backups);
  const orderedBackups = orderDatabaseBackups(snapshot.backups);
  const chooseRestoreTarget = (backup: DatabaseBackupInfo) => {
    if (busy) return;
    setHistoryOpen(false);
    setRestoreTarget(Object.freeze({ ...backup }));
  };
  return (
    <>
      {feedback ? (
        <p
          className={`settings-data-feedback is-${feedback.tone}`}
          role={feedback.tone === 'error' ? 'alert' : 'status'}
        >
          {feedback.message}
        </p>
      ) : null}
      {busy ? (
        <p className="settings-data-operation" role="status">
          <RefreshCw className="is-spinning" size={14} aria-hidden="true" />
          {dataOperationLabel(operation)}
        </p>
      ) : null}

      <div className="settings-group">
        <h2 id="settings-data-heading">本地数据库</h2>
        <p>状态属于整个应用，而不是某一个工作区。</p>
        <div className="data-health-grid">
          <DataMetric
            icon={ShieldCheck}
            label="完整性"
            value={snapshot.database.integrityCheck === 'ok' ? '正常' : '需检查'}
          />
          <DataMetric
            icon={Database}
            label="Schema"
            value={`v${snapshot.database.schemaVersion}`}
          />
          <DataMetric icon={HardDrive} label="SQLite" value={snapshot.database.sqliteVersion} />
          <DataMetric
            icon={Archive}
            label="可用备份"
            value={snapshot.database.backupCount.toLocaleString()}
          />
        </div>
      </div>

      <div className="settings-group">
        <div className="settings-group__heading">
          <div>
            <h2>备份</h2>
            <p>
              {latestBackup
                ? `上次备份 ${formatDateTime(latestBackup.createdAt)}`
                : '尚未创建可用备份'}
            </p>
          </div>
          <button
            type="button"
            className="secondary-button"
            disabled={busy}
            onClick={() => void runAction(onCreateBackup).catch(() => undefined)}
          >
            <Archive size={14} aria-hidden="true" /> 立即备份
          </button>
        </div>
        <BackupPolicyEditor
          key={snapshot.schedule.policy.revision}
          policy={snapshot.schedule.policy}
          nextRunAt={snapshot.schedule.nextRunAt}
          lastSuccessAt={snapshot.schedule.lastSuccessAt}
          running={snapshot.schedule.running}
          disabled={busy}
          onSave={(input) => runAction(() => onUpdatePolicy(input))}
        />
        {snapshot.schedule.lastErrorCode ? (
          <p className="backup-policy-error" role="alert">
            {BACKUP_ERROR_LABELS[snapshot.schedule.lastErrorCode]}
            {snapshot.schedule.consecutiveFailures > 1
              ? `，已连续失败 ${snapshot.schedule.consecutiveFailures} 次`
              : ''}
          </p>
        ) : null}
        {orderedBackups.length > 0 ? (
          <>
            <ul className="backup-list" aria-label="最近五份备份">
              {orderedBackups.slice(0, 5).map((backup) => (
                <li key={backup.id}>
                  <span>
                    <Archive size={14} aria-hidden="true" />
                  </span>
                  <div>
                    <strong>{formatBackupDateTime(backup.createdAt)}</strong>
                    <small>
                      {backupReasonLabel(backup.reason)} · Schema v{backup.schemaVersion}
                    </small>
                  </div>
                  <span className="backup-list__size">{formatBackupBytes(backup.sizeBytes)}</span>
                  <button
                    type="button"
                    className="backup-list__restore"
                    disabled={busy}
                    aria-label={`恢复 ${formatBackupDateTime(backup.createdAt)} 的备份`}
                    onClick={() => chooseRestoreTarget(backup)}
                  >
                    恢复
                  </button>
                </li>
              ))}
            </ul>
            <button
              type="button"
              className="backup-history-action"
              disabled={busy}
              onClick={() => setHistoryOpen(true)}
            >
              查看全部备份
              <span>{orderedBackups.length.toLocaleString()}</span>
              <ChevronRight size={14} aria-hidden="true" />
            </button>
          </>
        ) : null}
      </div>

      <div className="settings-group">
        <h2>可移植数据</h2>
        <p>导出完整本地数据；导入会先验证文件并展示替换预览。</p>
        <button
          type="button"
          className="setting-row"
          disabled={busy}
          onClick={() => void runAction(onExport).catch(() => undefined)}
        >
          <span>
            <Download size={17} aria-hidden="true" />
          </span>
          <div>
            <strong>导出数据</strong>
            <small>选择位置保存经过校验的可移植文件</small>
          </div>
          <ChevronRight size={16} aria-hidden="true" />
        </button>
        <button
          type="button"
          className="setting-row setting-row--danger"
          disabled={busy}
          onClick={() => void runAction(onChooseImport).catch(() => undefined)}
        >
          <span>
            <Upload size={17} aria-hidden="true" />
          </span>
          <div>
            <strong>导入并替换本地数据</strong>
            <small>确认前不会修改数据库；成功后应用会安全重启</small>
          </div>
          <ChevronRight size={16} aria-hidden="true" />
        </button>
      </div>

      {historyOpen ? (
        <BackupHistoryDialog
          backups={orderedBackups}
          busy={busy}
          onClose={() => setHistoryOpen(false)}
          onRestore={chooseRestoreTarget}
        />
      ) : null}
      {restoreTarget ? (
        <BackupRestoreDialog
          backup={restoreTarget}
          busy={busy}
          onClose={() => setRestoreTarget(null)}
          onConfirm={onRestoreBackup}
        />
      ) : null}
    </>
  );
}

interface BackupPolicyEditorProps {
  readonly policy: BackupPolicy;
  readonly nextRunAt: string | null;
  readonly lastSuccessAt: string | null;
  readonly running: boolean;
  readonly disabled: boolean;
  readonly onSave: (input: BackupPolicyUpdateInput) => void | Promise<void>;
}

function BackupPolicyEditor({
  policy,
  nextRunAt,
  lastSuccessAt,
  running,
  disabled,
  onSave,
}: BackupPolicyEditorProps) {
  const [enabled, setEnabled] = useState(policy.enabled);
  const [cadence, setCadence] = useState<BackupCadence>(policy.cadence);
  const [time, setTime] = useState(formatMinuteOfDay(policy.localTimeMinute));
  const [weekday, setWeekday] = useState(policy.weekday ?? 1);
  const [retentionCount, setRetentionCount] = useState(policy.retentionCount);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const localTimeMinute = parseMinuteOfDay(time);
    if (localTimeMinute === null || retentionCount < 1 || retentionCount > 90) return;
    void Promise.resolve(
      onSave({
        enabled,
        cadence,
        localTimeMinute,
        weekday: cadence === 'weekly' ? weekday : null,
        retentionCount,
        expectedRevision: policy.revision,
      }),
    ).catch(() => undefined);
  };

  return (
    <form className="backup-policy" onSubmit={submit}>
      <div className="backup-policy__summary">
        <span>
          <CalendarClock size={16} aria-hidden="true" />
        </span>
        <div>
          <strong>定时自动备份</strong>
          <small>
            {running
              ? '正在运行'
              : enabled && nextRunAt
                ? `下次 ${formatDateTime(nextRunAt)}`
                : '未启用'}
            {lastSuccessAt ? ` · 上次成功 ${formatDateTime(lastSuccessAt)}` : ''}
          </small>
        </div>
        <label className="backup-policy__toggle">
          <input
            type="checkbox"
            checked={enabled}
            disabled={disabled}
            onChange={(event) => setEnabled(event.target.checked)}
          />
          <span>启用</span>
        </label>
      </div>
      <div className="backup-policy__fields">
        <label>
          <span>频率</span>
          <select
            value={cadence}
            disabled={disabled || !enabled}
            onChange={(event) => setCadence(event.target.value as BackupCadence)}
          >
            <option value="daily">每天</option>
            <option value="weekly">每周</option>
          </select>
        </label>
        {cadence === 'weekly' ? (
          <label>
            <span>星期</span>
            <select
              value={weekday}
              disabled={disabled || !enabled}
              onChange={(event) => setWeekday(Number(event.target.value))}
            >
              {WEEKDAY_OPTIONS.map((label, index) => (
                <option value={index} key={label}>
                  {label}
                </option>
              ))}
            </select>
          </label>
        ) : null}
        <label>
          <span>本地时间</span>
          <input
            type="time"
            value={time}
            disabled={disabled || !enabled}
            onChange={(event) => setTime(event.target.value)}
            required
          />
        </label>
        <label>
          <span>保留份数</span>
          <input
            type="number"
            min={1}
            max={90}
            value={retentionCount}
            disabled={disabled || !enabled}
            onChange={(event) => setRetentionCount(Number(event.target.value))}
            required
          />
        </label>
        <button type="submit" className="secondary-button" disabled={disabled}>
          保存策略
        </button>
      </div>
    </form>
  );
}

function DataMetric({
  icon: Icon,
  label,
  value,
}: {
  readonly icon: typeof Database;
  readonly label: string;
  readonly value: string;
}) {
  return (
    <div className="data-health-metric">
      <Icon size={16} aria-hidden="true" />
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function ShortcutSettings() {
  return (
    <div className="settings-group">
      <h2>键盘快捷键</h2>
      <p>命令中心也会在每个快捷动作旁显示对应按键。</p>
      <dl className="shortcut-settings-list">
        <div>
          <dt>搜索或运行命令</dt>
          <dd>
            <kbd>Ctrl/Cmd K</kbd>
          </dd>
        </div>
        <div>
          <dt>快速记录</dt>
          <dd>
            <kbd>Ctrl/Cmd N</kbd>
          </dd>
        </div>
        <div>
          <dt>切换终端</dt>
          <dd>
            <kbd>Ctrl/Cmd J</kbd>
          </dd>
        </div>
      </dl>
    </div>
  );
}

function AboutSettings() {
  return (
    <div className="settings-group">
      <h2>Daily Workbench</h2>
      <p>本地优先的任务、笔记、浏览器与终端工作台。</p>
      <div className="setting-row setting-row--static">
        <span>
          <ShieldCheck size={17} aria-hidden="true" />
        </span>
        <div>
          <strong>本地业务数据</strong>
          <small>业务数据保存在本机 SQLite 数据库中</small>
        </div>
      </div>
    </div>
  );
}

function formatDateTime(value: string): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return '时间未知';
  return new Intl.DateTimeFormat('zh-CN', {
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date);
}

function formatMinuteOfDay(value: number): string {
  const hour = Math.floor(value / 60)
    .toString()
    .padStart(2, '0');
  const minute = (value % 60).toString().padStart(2, '0');
  return `${hour}:${minute}`;
}

function parseMinuteOfDay(value: string): number | null {
  const match = /^(\d{2}):(\d{2})$/u.exec(value);
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) return null;
  return hour * 60 + minute;
}
