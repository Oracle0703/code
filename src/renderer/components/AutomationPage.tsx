import {
  Bot,
  CalendarClock,
  CheckSquare2,
  FileText,
  Pencil,
  Plus,
  RefreshCw,
  Zap,
} from 'lucide-react';
import type { AutomationItem } from '../../shared/contracts';
import {
  describeAutomationAction,
  describeAutomationLastRun,
  formatAutomationDateTime,
  formatAutomationSchedule,
} from '../automation-state';
import { IconButton } from './IconButton';

interface AutomationPageProps {
  readonly items: readonly AutomationItem[];
  readonly status: 'loading' | 'ready' | 'error';
  readonly loadError: string | null;
  readonly operationError: string | null;
  readonly pendingItemIds: ReadonlySet<string>;
  readonly pendingCreate: boolean;
  readonly onRetry: () => void;
  readonly onOpenCreate: () => void;
  readonly onOpenEdit: (item: AutomationItem) => void;
  readonly onSetEnabled: (item: AutomationItem, enabled: boolean) => void | Promise<void>;
}

export function AutomationPage({
  items,
  status,
  loadError,
  operationError,
  pendingItemIds,
  pendingCreate,
  onRetry,
  onOpenCreate,
  onOpenEdit,
  onSetEnabled,
}: AutomationPageProps) {
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
            const ActionIcon = item.action.kind === 'create-today-task' ? CheckSquare2 : FileText;
            return (
              <li
                className={`automation-row ${item.enabled ? '' : 'is-disabled'}`}
                aria-busy={pending}
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

      <p className="sr-only" role="status" aria-live="polite" aria-atomic="true">
        {pendingCreate
          ? '正在创建自动化'
          : pendingItemIds.size > 0
            ? '正在保存自动化更改'
            : (operationError ?? '')}
      </p>
    </div>
  );
}
