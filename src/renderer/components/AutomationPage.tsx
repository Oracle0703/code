import {
  ArrowRight,
  Bot,
  CalendarClock,
  CheckCircle2,
  CheckSquare2,
  FileText,
  LoaderCircle,
  Pencil,
  Play,
  Plus,
  RefreshCw,
  Zap,
} from 'lucide-react';
import { useLayoutEffect, useRef, useState } from 'react';
import type { AutomationItem } from '../../shared/contracts';
import {
  automationOutputOpenFailed,
  automationOutputOpenFinished,
  automationOutputOpenStarted,
  AutomationOutputOpenGate,
  type AutomationOutputOpenState,
} from '../automation-output-navigation';
import {
  describeAutomationAction,
  describeAutomationLastRun,
  formatAutomationDateTime,
  formatAutomationSchedule,
  automationRunFeedbackKey,
  automationRunOutputLabel,
  requestAutomationRunNow,
  type AutomationRunActivity,
  type AutomationRunFeedback,
} from '../automation-state';
import { AutomationRunSyncWarning } from './AutomationRunSyncWarning';
import { IconButton } from './IconButton';

interface AutomationPageProps {
  readonly items: readonly AutomationItem[];
  readonly status: 'loading' | 'ready' | 'error';
  readonly loadError: string | null;
  readonly operationError: string | null;
  readonly runFeedback: AutomationRunFeedback | null;
  readonly runSyncWarning: AutomationRunFeedback | null;
  readonly runBlocked: boolean;
  readonly runActivity: AutomationRunActivity | null;
  readonly runSyncWarningRefreshing: boolean;
  readonly runSyncWarningError: string | null;
  readonly runSyncWarningFocusBlocked: boolean;
  readonly focusRunSyncWarningAction?: boolean;
  readonly pendingItemIds: ReadonlySet<string>;
  readonly runningItemIds: ReadonlySet<string>;
  readonly pendingCreate: boolean;
  readonly onRetry: () => void;
  readonly onOpenCreate: () => void;
  readonly onOpenEdit: (item: AutomationItem) => void;
  readonly onSetEnabled: (item: AutomationItem, enabled: boolean) => void | Promise<void>;
  readonly onRunNow: (item: AutomationItem) => void | Promise<void>;
  readonly onOpenRunOutput: (feedback: AutomationRunFeedback) => void | Promise<void>;
  readonly onRefreshRunSyncWarning: (warning: AutomationRunFeedback) => void | Promise<void>;
}

export function AutomationPage({
  items,
  status,
  loadError,
  operationError,
  runFeedback,
  runSyncWarning,
  runBlocked,
  runActivity,
  runSyncWarningRefreshing,
  runSyncWarningError,
  runSyncWarningFocusBlocked,
  focusRunSyncWarningAction = false,
  pendingItemIds,
  runningItemIds,
  pendingCreate,
  onRetry,
  onOpenCreate,
  onOpenEdit,
  onSetEnabled,
  onRunNow,
  onOpenRunOutput,
  onRefreshRunSyncWarning,
}: AutomationPageProps) {
  const outputOpenGateRef = useRef(new AutomationOutputOpenGate());
  const currentRunFeedbackRef = useRef(runFeedback);
  const currentRunSyncWarningRef = useRef(runSyncWarning);
  useLayoutEffect(() => {
    currentRunFeedbackRef.current = runFeedback;
    currentRunSyncWarningRef.current = runSyncWarning;
  }, [runFeedback, runSyncWarning]);
  const navigationErrorRef = useRef<HTMLParagraphElement>(null);
  const runFeedbackActionRef = useRef<HTMLButtonElement>(null);
  const pendingRunFeedbackFocusKeyRef = useRef<string | null>(null);
  const [outputOpenState, setOutputOpenState] = useState<AutomationOutputOpenState | null>(null);
  const runFeedbackKey = runFeedback === null ? null : automationRunFeedbackKey(runFeedback);
  const runSyncWarningKey =
    runSyncWarning === null ? null : automationRunFeedbackKey(runSyncWarning);
  const openingOutput =
    runFeedback !== null &&
    outputOpenState?.outputKey === runFeedbackKey &&
    outputOpenState.opening;
  const outputNavigationError =
    runFeedback !== null && outputOpenState?.outputKey === runFeedbackKey
      ? outputOpenState.error
      : null;
  const runActivityItem =
    runActivity === null ? null : (items.find(({ id }) => id === runActivity.automationId) ?? null);
  const runControlsBlocked = runBlocked || runActivity !== null || runSyncWarning !== null;
  const runActivityStatus = automationRunActivityStatus(
    runActivity,
    runActivityItem?.name ?? null,
    runSyncWarning,
    runSyncWarningRefreshing,
    runBlocked,
  );

  useLayoutEffect(() => {
    const expectedKey = pendingRunFeedbackFocusKeyRef.current;
    if (expectedKey === null) return;
    if (runSyncWarningKey === expectedKey) return;
    pendingRunFeedbackFocusKeyRef.current = null;
    if (runSyncWarning !== null || runFeedbackKey !== expectedKey) return;
    const frame = window.requestAnimationFrame(() => {
      const feedback = currentRunFeedbackRef.current;
      const focusWasLost =
        document.activeElement === null || document.activeElement === document.body;
      if (
        focusWasLost &&
        currentRunSyncWarningRef.current === null &&
        feedback !== null &&
        automationRunFeedbackKey(feedback) === expectedKey
      ) {
        runFeedbackActionRef.current?.focus({ preventScroll: true });
      }
    });
    return () => window.cancelAnimationFrame(frame);
  }, [runFeedbackKey, runSyncWarning, runSyncWarningKey]);

  const openRunOutput = async (feedback: AutomationRunFeedback): Promise<void> => {
    const outputKey = automationRunFeedbackKey(feedback);
    if (!outputOpenGateRef.current.begin(outputKey)) return;
    setOutputOpenState(automationOutputOpenStarted(outputKey));
    try {
      await onOpenRunOutput(feedback);
    } catch (error) {
      const message =
        error instanceof Error && error.message.trim().length > 0
          ? error.message
          : feedback.outputKind === 'task'
            ? '无法打开刚创建的任务，请重试。'
            : '无法打开刚创建的笔记，请重试。';
      setOutputOpenState((current) => automationOutputOpenFailed(current, outputKey, message));
      window.requestAnimationFrame(() => {
        if (
          currentRunFeedbackRef.current !== null &&
          automationRunFeedbackKey(currentRunFeedbackRef.current) === outputKey
        ) {
          navigationErrorRef.current?.focus();
        }
      });
    } finally {
      outputOpenGateRef.current.end(outputKey);
      setOutputOpenState((current) => automationOutputOpenFinished(current, outputKey));
    }
  };

  const refreshRunSyncWarning = async (
    warning: AutomationRunFeedback,
    restoreOutputActionFocus: boolean,
  ): Promise<void> => {
    const warningKey = automationRunFeedbackKey(warning);
    pendingRunFeedbackFocusKeyRef.current = restoreOutputActionFocus ? warningKey : null;
    try {
      await onRefreshRunSyncWarning(warning);
    } catch (error) {
      if (pendingRunFeedbackFocusKeyRef.current === warningKey) {
        pendingRunFeedbackFocusKeyRef.current = null;
      }
      throw error;
    }
  };

  return (
    <div className="section-page automation-page">
      <header className="section-page__header">
        <div className="section-page__title">
          <span>
            <Bot size={20} aria-hidden="true" />
          </span>
          <div>
            <h1 tabIndex={-1}>自动化</h1>
            <p>按本地时间自动创建今日任务或 Markdown 笔记。</p>
          </div>
        </div>
        <button
          type="button"
          className="primary-button"
          disabled={pendingCreate}
          onClick={onOpenCreate}
        >
          <Plus size={15} aria-hidden="true" />
          {pendingCreate ? '创建中…' : '新建自动化'}
        </button>
      </header>

      <section className="automation-hero" aria-labelledby="automation-runtime-heading">
        <span>
          <Zap size={21} aria-hidden="true" />
        </span>
        <div>
          <h2 id="automation-runtime-heading">仅在 Daily Workbench 运行时执行</h2>
          <p>应用关闭期间不会运行；再次启动时，每条规则最多补执行最近一次错过的计划。</p>
        </div>
      </section>

      {operationError ? (
        <p className="automation-feedback is-error" role="alert">
          {operationError}
        </p>
      ) : null}
      {runSyncWarning ? (
        <AutomationRunSyncWarning
          key={runSyncWarningKey}
          feedback={runSyncWarning}
          focusActionOnMount={focusRunSyncWarningAction}
          focusBlocked={runSyncWarningFocusBlocked}
          refreshing={runSyncWarningRefreshing}
          refreshError={runSyncWarningError}
          onRefresh={(restoreOutputActionFocus) =>
            refreshRunSyncWarning(runSyncWarning, restoreOutputActionFocus)
          }
        />
      ) : runFeedback ? (
        <div className="automation-feedback is-success" aria-busy={openingOutput}>
          <CheckCircle2 size={14} aria-hidden="true" />
          <span>{runFeedback.message}</span>
          <button
            ref={runFeedbackActionRef}
            type="button"
            className="automation-feedback__action"
            aria-label={`${automationRunOutputLabel(runFeedback)}：刚创建的${
              runFeedback.outputKind === 'task' ? '任务' : '笔记'
            }“${runFeedback.outputTitle}”`}
            disabled={openingOutput}
            onClick={() => void openRunOutput(runFeedback)}
          >
            {openingOutput ? (
              <LoaderCircle className="is-spinning" size={13} aria-hidden="true" />
            ) : (
              <ArrowRight size={13} aria-hidden="true" />
            )}
            {openingOutput ? '正在打开…' : automationRunOutputLabel(runFeedback)}
          </button>
        </div>
      ) : null}
      {outputNavigationError ? (
        <p
          className="automation-feedback is-error"
          ref={navigationErrorRef}
          role="alert"
          tabIndex={-1}
        >
          {outputNavigationError}
        </p>
      ) : null}

      {status === 'loading' && items.length === 0 ? (
        <div className="automation-state" role="status">
          <RefreshCw className="is-spinning" size={18} aria-hidden="true" />
          <strong>正在读取自动化…</strong>
          <span>从当前工作区的本地数据库载入规则。</span>
        </div>
      ) : status === 'error' && items.length === 0 ? (
        <div className="automation-state is-error" role="alert">
          <Bot size={20} aria-hidden="true" />
          <strong>自动化暂时无法读取</strong>
          <span>{loadError ?? '请稍后重试。'}</span>
          <button type="button" className="secondary-button" onClick={onRetry}>
            <RefreshCw size={14} aria-hidden="true" /> 重试
          </button>
        </div>
      ) : items.length === 0 ? (
        <div className="automation-state automation-state--empty">
          <CalendarClock size={23} aria-hidden="true" />
          <strong>还没有自动化</strong>
          <span>创建一条每日或每周规则，让重复记录自动进入当前工作区。</span>
          <button type="button" className="secondary-button" onClick={onOpenCreate}>
            <Plus size={14} aria-hidden="true" /> 创建第一条自动化
          </button>
        </div>
      ) : (
        <ul className="automation-list" aria-label="自动化规则">
          {items.map((item) => {
            const pending = pendingItemIds.has(item.id);
            const activityPhase = runActivity?.automationId === item.id ? runActivity.phase : null;
            const running =
              activityPhase === 'running' || (runActivity === null && runningItemIds.has(item.id));
            const confirming = activityPhase === 'confirming';
            const runBusy = running || confirming;
            const ActionIcon = item.action.kind === 'create-today-task' ? CheckSquare2 : FileText;
            return (
              <li
                className={`automation-row ${item.enabled ? '' : 'is-disabled'}`}
                aria-busy={pending || runBusy}
                key={item.id}
              >
                <span className="automation-row__icon">
                  <ActionIcon size={16} aria-hidden="true" />
                </span>
                <div className="automation-row__content">
                  <strong>{item.name}</strong>
                  <p>{describeAutomationAction(item.action)}</p>
                  <div className="automation-row__meta">
                    <span>
                      <CalendarClock size={12} aria-hidden="true" />
                      {formatAutomationSchedule(item.schedule)}
                    </span>
                    <span>{describeAutomationLastRun(item.lastRun)}</span>
                  </div>
                </div>
                <div className="automation-row__next">
                  <small>{item.enabled ? '下次运行' : '状态'}</small>
                  <strong>
                    {item.enabled
                      ? item.nextRunAt
                        ? formatAutomationDateTime(item.nextRunAt)
                        : '等待调度'
                      : '已停用'}
                  </strong>
                </div>
                <button
                  type="button"
                  className="automation-row__run"
                  data-automation-run-id={item.id}
                  aria-busy={runBusy}
                  aria-label={
                    running
                      ? `正在立即运行自动化“${item.name}”`
                      : confirming
                        ? `正在确认自动化“${item.name}”的输出`
                        : `立即运行自动化“${item.name}”`
                  }
                  aria-describedby={
                    runControlsBlocked ? 'automation-run-activity-status' : undefined
                  }
                  disabled={pending || runControlsBlocked}
                  onClick={() => {
                    void requestAutomationRunNow(item, onRunNow).catch(() => undefined);
                  }}
                >
                  {runBusy ? (
                    <LoaderCircle className="is-spinning" size={13} aria-hidden="true" />
                  ) : (
                    <Play size={13} fill="currentColor" aria-hidden="true" />
                  )}
                  {running ? '运行中…' : confirming ? '确认输出…' : '立即运行'}
                </button>
                <button
                  type="button"
                  className={`automation-switch ${item.enabled ? 'is-on' : ''}`}
                  role="switch"
                  aria-checked={item.enabled}
                  aria-label={`${item.enabled ? '停用' : '启用'}自动化“${item.name}”`}
                  disabled={pending}
                  onClick={() => {
                    void Promise.resolve(onSetEnabled(item, !item.enabled)).catch(() => undefined);
                  }}
                >
                  <i aria-hidden="true" />
                </button>
                <IconButton
                  label={`编辑自动化“${item.name}”`}
                  disabled={pending}
                  onClick={() => onOpenEdit(item)}
                >
                  <Pencil size={15} aria-hidden="true" />
                </IconButton>
              </li>
            );
          })}
        </ul>
      )}

      <p
        id="automation-run-activity-status"
        className="sr-only"
        role={runSyncWarning ? undefined : 'status'}
        aria-live={runSyncWarning ? undefined : 'polite'}
        aria-atomic="true"
      >
        {runActivityStatus !== null
          ? runActivityStatus
          : runFeedback
            ? `${runFeedback.message}；可以${
                runFeedback.outputKind === 'task' ? '打开刚创建的任务' : '打开刚创建的笔记'
              }。`
            : pendingCreate
              ? '正在创建自动化'
              : runningItemIds.size > 0
                ? '正在立即运行自动化'
                : pendingItemIds.size > 0
                  ? '正在保存自动化更改'
                  : ''}
      </p>
    </div>
  );
}

function automationRunActivityStatus(
  activity: AutomationRunActivity | null,
  automationName: string | null,
  warning: AutomationRunFeedback | null,
  warningRefreshing: boolean,
  blocked: boolean,
): string | null {
  const namedAutomation = automationName === null ? '当前自动化' : `自动化“${automationName}”`;
  if (activity?.phase === 'running') {
    return `正在立即运行${namedAutomation}；完成前其他立即运行操作暂不可用。`;
  }
  if (activity?.phase === 'confirming') {
    return `正在确认${namedAutomation}的精确输出；确认完成前其他立即运行操作暂不可用。`;
  }
  if (activity?.phase === 'recovering' || warningRefreshing) {
    return '正在重新读取并确认自动化输出；确认完成前所有立即运行操作暂不可用。';
  }
  if (warning !== null) {
    return '上一次自动化已经运行但输出尚未确认；请先重新读取，不要再次运行。';
  }
  if (blocked) {
    return '这个工作区正在运行或确认另一条自动化；完成前所有立即运行操作暂不可用。';
  }
  return null;
}
