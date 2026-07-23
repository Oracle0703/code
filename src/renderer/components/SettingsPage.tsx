import {
  Archive,
  CalendarClock,
  ChevronRight,
  Database,
  Download,
  Globe2,
  HardDrive,
  RefreshCw,
  Settings2,
  ShieldCheck,
  SquareTerminal,
  Upload,
} from 'lucide-react';
import { useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import type {
  BackupCadence,
  BackupPolicy,
  BackupPolicyUpdateInput,
  BackupRunErrorCode,
  DataManagementSnapshot,
  DatabaseBackupReason,
} from '../../shared/contracts';
import {
  dataOperationLabel,
  latestDatabaseBackup,
  type DataFeedback,
  type DataLoadStatus,
  type DataOperationKind,
} from '../data-state';

export type SettingsSection = 'general' | 'appearance' | 'data' | 'shortcuts' | 'about';

interface SettingsPageProps {
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
  readonly onUpdateBackupPolicy: (input: BackupPolicyUpdateInput) => void | Promise<void>;
  readonly onExportData: () => void | Promise<void>;
  readonly onChooseImport: () => void | Promise<void>;
}

const SETTINGS_SECTIONS: readonly { id: SettingsSection; label: string }[] = [
  { id: 'general', label: '通用' },
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

const BACKUP_REASON_LABELS: Record<DatabaseBackupReason, string> = {
  manual: '手动',
  scheduled: '定时',
  'pre-migration': '迁移前',
  'pre-import': '导入前',
};

const BACKUP_ERROR_LABELS: Record<BackupRunErrorCode, string> = {
  'backup-failed': '无法创建一致性备份',
  'retention-failed': '备份已创建，但旧备份清理失败',
  'database-unavailable': '数据库暂时不可用',
};

export function SettingsPage({
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
  onUpdateBackupPolicy,
  onExportData,
  onChooseImport,
}: SettingsPageProps) {
  const [internalSection, setInternalSection] = useState(defaultSection);
  const activeSection = section ?? internalSection;
  const busy = dataOperation !== null;

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
          {activeSection === 'appearance' ? <AppearanceSettings /> : null}
          {activeSection === 'data' ? (
            <DataSettings
              snapshot={dataSnapshot}
              status={dataStatus}
              operation={dataOperation}
              feedback={dataFeedback}
              onRetry={onRetryData}
              onCreateBackup={onCreateBackup}
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
        {busy ? dataOperationLabel(dataOperation) : (dataFeedback?.message ?? '')}
      </p>
    </div>
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
  readonly onUpdatePolicy: (input: BackupPolicyUpdateInput) => void | Promise<void>;
  readonly onExport: () => void | Promise<void>;
  readonly onChooseImport: () => void | Promise<void>;
}

function DataSettings({
  snapshot,
  status,
  operation,
  feedback,
  onRetry,
  onCreateBackup,
  onUpdatePolicy,
  onExport,
  onChooseImport,
}: DataSettingsProps) {
  const actionInFlightRef = useRef(false);
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
        {snapshot.backups.length > 0 ? (
          <ul className="backup-list" aria-label="最近备份">
            {snapshot.backups.slice(0, 5).map((backup) => (
              <li key={backup.id}>
                <span>
                  <Archive size={14} aria-hidden="true" />
                </span>
                <div>
                  <strong>{formatDateTime(backup.createdAt)}</strong>
                  <small>
                    {BACKUP_REASON_LABELS[backup.reason]} · Schema v{backup.schemaVersion}
                  </small>
                </div>
                <span>{formatBytes(backup.sizeBytes)}</span>
              </li>
            ))}
          </ul>
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
            <kbd>Ctrl J</kbd>
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
          <strong>本地模式</strong>
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

function formatBytes(value: number): string {
  if (!Number.isFinite(value) || value < 0) return '大小未知';
  if (value < 1_024) return `${value} B`;
  if (value < 1_048_576) return `${(value / 1_024).toFixed(1)} KiB`;
  return `${(value / 1_048_576).toFixed(1)} MiB`;
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
