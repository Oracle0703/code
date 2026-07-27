import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  Archive,
  ArrowRight,
  CheckCircle2,
  CheckSquare2,
  FileText,
  Filter,
  Globe2,
  Inbox,
  LoaderCircle,
  Plus,
  Search,
  Sparkles,
  X,
} from 'lucide-react';
import type { InboxCategory, InboxEntry } from '../../shared/contracts';
import { InboxConversionSyncWarning } from './InboxConversionSyncWarning';
import {
  inboxConversionFeedbackKey,
  inboxConversionOpenFailed,
  inboxConversionOpenFinished,
  inboxConversionOpenStarted,
  InboxConversionOpenGate,
  type InboxConversionFeedback,
  type InboxConversionOpenState,
} from '../inbox-conversion-navigation';
import { filterInboxEntries, type InboxFilter } from '../inbox-state';

interface InboxPageProps {
  entries: readonly InboxEntry[];
  status: 'loading' | 'ready' | 'error';
  loadError: string | null;
  operationError: string | null;
  conversionFeedback: InboxConversionFeedback | null;
  conversionSyncWarning?: {
    readonly feedback: InboxConversionFeedback;
    readonly message: string;
    readonly focusActionOnMount: boolean;
  } | null;
  conversionFeedbackFocusBlocked: boolean;
  focusedConversionFeedbackKey: string | null;
  pendingEntryIds: ReadonlySet<string>;
  pendingConversionEntryIds: ReadonlySet<string>;
  pendingNoteConversionEntryIds: ReadonlySet<string>;
  conversionMutationPending: boolean;
  requestedEntryId?: string | null;
  onRequestedEntryHandled?: () => void;
  onRetry: () => void;
  onOpenCapture: () => void;
  onCategorize: (entryId: string, category: InboxCategory) => Promise<void>;
  onArchive: (entry: InboxEntry) => Promise<void>;
  onDismissConversionFeedback: (feedback: InboxConversionFeedback) => void;
  onOpenConversionOutput: (feedback: InboxConversionFeedback) => Promise<void>;
  onRefreshConversionSyncWarning?: (feedback: InboxConversionFeedback) => Promise<void>;
  onConversionFeedbackFocused: (feedbackKey: string) => void;
  onOpenConvert: (entry: InboxEntry) => void;
  onConvertNote: (entry: InboxEntry) => Promise<void>;
}

const categoryLabels: Record<InboxCategory, string> = {
  uncategorized: '未分类',
  task: '任务线索',
  note: '笔记',
  link: '链接',
};

const filters: readonly { id: InboxFilter; label: string }[] = [
  { id: 'all', label: '全部' },
  { id: 'uncategorized', label: '未分类' },
  { id: 'task', label: '任务线索' },
  { id: 'note', label: '笔记' },
  { id: 'link', label: '链接' },
];

export function InboxPage({
  entries,
  status,
  loadError,
  operationError,
  conversionFeedback,
  conversionSyncWarning = null,
  conversionFeedbackFocusBlocked,
  focusedConversionFeedbackKey,
  pendingEntryIds,
  pendingConversionEntryIds,
  pendingNoteConversionEntryIds,
  conversionMutationPending,
  requestedEntryId = null,
  onRequestedEntryHandled,
  onRetry,
  onOpenCapture,
  onCategorize,
  onArchive,
  onDismissConversionFeedback,
  onOpenConversionOutput,
  onRefreshConversionSyncWarning = async () => undefined,
  onConversionFeedbackFocused,
  onOpenConvert,
  onConvertNote,
}: InboxPageProps) {
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<InboxFilter>('all');
  const [conversionOpenGate] = useState(() => new InboxConversionOpenGate());
  const [conversionOpenState, setConversionOpenState] = useState<InboxConversionOpenState | null>(
    null,
  );
  const headingRef = useRef<HTMLHeadingElement>(null);
  const conversionActionRef = useRef<HTMLButtonElement>(null);
  const conversionErrorRef = useRef<HTMLParagraphElement>(null);
  const conversionFeedbackRef = useRef(conversionFeedback);
  const conversionErrorFocusSequenceRef = useRef(0);
  const focusedConversionErrorKeyRef = useRef<string | null>(null);
  const entryRefs = useRef(new Map<string, HTMLLIElement>());
  const noteConversionButtonRefs = useRef(new Map<string, HTMLButtonElement>());
  const conversionFeedbackKey =
    conversionFeedback === null ? null : inboxConversionFeedbackKey(conversionFeedback);
  const openingConversionOutput =
    conversionFeedback !== null &&
    conversionOpenState?.feedbackKey === conversionFeedbackKey &&
    conversionOpenState.opening;
  const conversionNavigationError =
    conversionFeedback !== null && conversionOpenState?.feedbackKey === conversionFeedbackKey
      ? conversionOpenState.error
      : null;
  const conversionNavigationErrorKey =
    conversionNavigationError !== null ? (conversionOpenState?.errorFocusKey ?? null) : null;
  const visibleEntries = useMemo(
    () => filterInboxEntries(entries, query, filter, requestedEntryId),
    [entries, filter, query, requestedEntryId],
  );

  useLayoutEffect(() => {
    conversionFeedbackRef.current = conversionFeedback;
  }, [conversionFeedback]);

  useEffect(() => {
    if (
      conversionFeedbackKey === null ||
      conversionFeedbackFocusBlocked ||
      focusedConversionFeedbackKey === conversionFeedbackKey
    ) {
      return;
    }
    const frame = window.requestAnimationFrame(() => {
      if (
        conversionFeedbackRef.current !== null &&
        inboxConversionFeedbackKey(conversionFeedbackRef.current) === conversionFeedbackKey
      ) {
        const action = conversionActionRef.current;
        action?.focus({ preventScroll: true });
        if (document.activeElement === action) {
          onConversionFeedbackFocused(conversionFeedbackKey);
        }
      }
    });
    return () => window.cancelAnimationFrame(frame);
  }, [
    conversionFeedbackFocusBlocked,
    conversionFeedbackKey,
    focusedConversionFeedbackKey,
    onConversionFeedbackFocused,
    status,
  ]);

  useEffect(() => {
    if (
      conversionNavigationErrorKey === null ||
      conversionFeedbackFocusBlocked ||
      focusedConversionErrorKeyRef.current === conversionNavigationErrorKey
    ) {
      return;
    }
    const frame = window.requestAnimationFrame(() => {
      const error = conversionErrorRef.current;
      error?.focus({ preventScroll: true });
      if (document.activeElement === error) {
        focusedConversionErrorKeyRef.current = conversionNavigationErrorKey;
      }
    });
    return () => window.cancelAnimationFrame(frame);
  }, [conversionFeedbackFocusBlocked, conversionNavigationErrorKey, status]);

  useEffect(() => {
    if (!requestedEntryId) return;
    let handledTimer: number | null = null;
    const frame = window.requestAnimationFrame(() => {
      const entry = entryRefs.current.get(requestedEntryId);
      if (!entry) return;
      entry.scrollIntoView({ block: 'center' });
      entry.focus({ preventScroll: true });
      handledTimer = window.setTimeout(() => onRequestedEntryHandled?.(), 1_600);
    });
    return () => {
      window.cancelAnimationFrame(frame);
      if (handledTimer !== null) window.clearTimeout(handledTimer);
    };
  }, [entries, onRequestedEntryHandled, requestedEntryId]);

  const openConversionOutput = async (feedback: InboxConversionFeedback): Promise<void> => {
    if (!conversionOpenGate.begin(feedback)) return;
    setConversionOpenState(inboxConversionOpenStarted(feedback));
    try {
      await onOpenConversionOutput(feedback);
    } catch (error) {
      const message =
        error instanceof Error && error.message.trim().length > 0
          ? error.message
          : feedback.outputKind === 'task'
            ? '无法打开刚转换的任务，请重试。'
            : '无法打开刚转换的笔记，请重试。';
      conversionErrorFocusSequenceRef.current += 1;
      const errorFocusKey = JSON.stringify([
        inboxConversionFeedbackKey(feedback),
        conversionErrorFocusSequenceRef.current,
        message,
      ]);
      setConversionOpenState((current) =>
        inboxConversionOpenFailed(current, feedback, message, errorFocusKey),
      );
    } finally {
      conversionOpenGate.end(feedback);
      setConversionOpenState((current) => inboxConversionOpenFinished(current, feedback));
    }
  };

  return (
    <div className="section-page inbox-page" aria-busy={status === 'loading'}>
      <header className="section-page__header">
        <div className="section-page__title">
          <span>
            <Inbox size={20} />
          </span>
          <div>
            <h1 ref={headingRef} tabIndex={-1}>
              收件箱
            </h1>
            <p>{entries.length > 0 ? `${entries.length} 项等待处理` : '随手记录，稍后再整理。'}</p>
          </div>
        </div>
        <button type="button" className="primary-button" onClick={onOpenCapture}>
          <Plus size={15} /> 快速记录
        </button>
      </header>

      {status === 'error' ? (
        <section className="inbox-state" role="alert">
          <Inbox size={24} />
          <h2>收件箱暂时无法读取</h2>
          <p>{loadError ?? '请稍后重试。'}</p>
          <button type="button" className="secondary-button" onClick={onRetry}>
            重新加载
          </button>
        </section>
      ) : status === 'loading' ? (
        <section className="inbox-state">
          <LoaderCircle className="is-spinning" size={24} />
          <h2>正在读取收件箱</h2>
          <p>正在从当前工作区的 SQLite 数据中加载记录…</p>
        </section>
      ) : (
        <section className="inbox-view">
          <div className="page-toolbar inbox-toolbar">
            <label className="page-search">
              <Search size={15} />
              <span className="sr-only">搜索收件箱</span>
              <input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="搜索收件箱"
              />
            </label>
            <span className="inbox-toolbar__label">
              <Filter size={14} /> 分类
            </span>
          </div>

          <div className="inbox-filters" role="group" aria-label="收件箱分类筛选">
            {filters.map(({ id, label }) => {
              const count =
                id === 'all'
                  ? entries.length
                  : entries.filter(({ category }) => category === id).length;
              return (
                <button
                  type="button"
                  key={id}
                  className={filter === id ? 'is-active' : ''}
                  aria-pressed={filter === id}
                  onClick={() => setFilter(id)}
                >
                  {label} <small>{count}</small>
                </button>
              );
            })}
          </div>

          {conversionSyncWarning ? (
            <InboxConversionSyncWarning
              outputKind={conversionSyncWarning.feedback.outputKind}
              outputTitle={conversionSyncWarning.feedback.outputTitle}
              message={conversionSyncWarning.message}
              focusActionOnMount={conversionSyncWarning.focusActionOnMount}
              focusBlocked={conversionFeedbackFocusBlocked}
              onRefresh={() => onRefreshConversionSyncWarning(conversionSyncWarning.feedback)}
            />
          ) : null}

          {conversionFeedback ? (
            <div
              className="inbox-conversion-feedback"
              aria-busy={openingConversionOutput}
              data-conversion-feedback={conversionFeedbackKey ?? undefined}
            >
              <CheckCircle2 size={17} aria-hidden="true" />
              <div>
                <strong>已转为{conversionFeedback.outputKind === 'task' ? '任务' : '笔记'}</strong>
                <span>{conversionFeedback.outputTitle}</span>
              </div>
              <button
                ref={conversionActionRef}
                type="button"
                className="inbox-conversion-feedback__open"
                aria-label={`已转为${
                  conversionFeedback.outputKind === 'task' ? '任务' : '笔记'
                }“${conversionFeedback.outputTitle}”；打开${
                  conversionFeedback.outputKind === 'task' ? '任务' : '笔记'
                }`}
                disabled={openingConversionOutput}
                onClick={() => void openConversionOutput(conversionFeedback)}
              >
                {openingConversionOutput ? (
                  <LoaderCircle className="is-spinning" size={14} aria-hidden="true" />
                ) : (
                  <ArrowRight size={14} aria-hidden="true" />
                )}
                {openingConversionOutput
                  ? '正在打开…'
                  : `打开${conversionFeedback.outputKind === 'task' ? '任务' : '笔记'}`}
              </button>
              <button
                type="button"
                className="inbox-conversion-feedback__dismiss"
                aria-label="关闭转换成功提示"
                disabled={openingConversionOutput}
                onClick={() => {
                  onDismissConversionFeedback(conversionFeedback);
                  window.requestAnimationFrame(() =>
                    headingRef.current?.focus({ preventScroll: true }),
                  );
                }}
              >
                <X size={14} aria-hidden="true" />
              </button>
            </div>
          ) : null}
          {conversionNavigationError ? (
            <p
              className="inbox-conversion-navigation-error"
              ref={conversionErrorRef}
              role="alert"
              tabIndex={-1}
            >
              {conversionNavigationError}
            </p>
          ) : null}

          {operationError ? (
            <p className="inbox-operation-error" role="alert">
              {operationError}
            </p>
          ) : null}

          {visibleEntries.length > 0 ? (
            <ul className="inbox-list" aria-label="收件箱记录">
              {visibleEntries.map((entry) => {
                const pending =
                  pendingEntryIds.has(entry.id) ||
                  pendingConversionEntryIds.has(entry.id) ||
                  pendingNoteConversionEntryIds.has(entry.id) ||
                  conversionSyncWarning !== null;
                const conversionPending = pending || conversionMutationPending;
                const Icon = categoryIcon(entry.category);
                return (
                  <li
                    ref={(element) => {
                      if (element) entryRefs.current.set(entry.id, element);
                      else entryRefs.current.delete(entry.id);
                    }}
                    className={`inbox-entry ${
                      requestedEntryId === entry.id ? 'is-search-target' : ''
                    }`}
                    tabIndex={-1}
                    aria-current={requestedEntryId === entry.id ? 'true' : undefined}
                    key={entry.id}
                  >
                    <span className={`inbox-entry__icon is-${entry.category}`}>
                      <Icon size={16} aria-hidden="true" />
                    </span>
                    <div className="inbox-entry__body">
                      <strong>{entry.content}</strong>
                      <small>
                        {categoryLabels[entry.category]} ·{' '}
                        <time dateTime={entry.createdAt}>{formatTimestamp(entry.createdAt)}</time>
                      </small>
                    </div>
                    <label className="inbox-entry__category">
                      <span className="sr-only">修改“{entry.content}”的分类</span>
                      <select
                        value={entry.category}
                        disabled={pending}
                        onChange={(event) => {
                          void onCategorize(entry.id, event.target.value as InboxCategory).catch(
                            () => undefined,
                          );
                        }}
                      >
                        <option value="uncategorized">未分类</option>
                        <option value="task">任务线索</option>
                        <option value="note">笔记</option>
                        <option value="link">链接</option>
                      </select>
                    </label>
                    <div className="inbox-entry__conversions">
                      <button
                        type="button"
                        className="inbox-entry__convert"
                        aria-label={`转为任务：${entry.content}`}
                        disabled={conversionPending}
                        onClick={() => onOpenConvert(entry)}
                      >
                        {pendingConversionEntryIds.has(entry.id) ? (
                          <LoaderCircle className="is-spinning" size={14} />
                        ) : (
                          <CheckSquare2 size={14} />
                        )}
                        {pendingConversionEntryIds.has(entry.id) ? '转换中…' : '转任务'}
                      </button>
                      <button
                        ref={(element) => {
                          if (element) noteConversionButtonRefs.current.set(entry.id, element);
                          else noteConversionButtonRefs.current.delete(entry.id);
                        }}
                        type="button"
                        className="inbox-entry__convert inbox-entry__convert--note"
                        aria-label={`转为笔记：${entry.content}`}
                        disabled={conversionPending}
                        onClick={() => {
                          void onConvertNote(entry).catch(() => {
                            window.requestAnimationFrame(() => {
                              const action = noteConversionButtonRefs.current.get(entry.id);
                              if (action && !action.disabled) {
                                action.focus({ preventScroll: true });
                              } else {
                                entryRefs.current.get(entry.id)?.focus({ preventScroll: true });
                              }
                            });
                          });
                        }}
                      >
                        {pendingNoteConversionEntryIds.has(entry.id) ? (
                          <LoaderCircle className="is-spinning" size={14} />
                        ) : (
                          <FileText size={14} />
                        )}
                        {pendingNoteConversionEntryIds.has(entry.id) ? '转换中…' : '转笔记'}
                      </button>
                    </div>
                    <button
                      type="button"
                      className="inbox-entry__archive"
                      aria-label={`归档：${entry.content}`}
                      disabled={pending}
                      onClick={() => void onArchive(entry).catch(() => undefined)}
                    >
                      {pending ? (
                        <LoaderCircle className="is-spinning" size={15} />
                      ) : (
                        <Archive size={15} />
                      )}
                    </button>
                  </li>
                );
              })}
            </ul>
          ) : entries.length === 0 ? (
            <div className="inbox-empty">
              <span>
                <Sparkles size={21} />
              </span>
              <h2>收件箱已经清空</h2>
              <p>使用 Ctrl+N 随时记下新的待办、想法或链接。</p>
              <button type="button" className="secondary-button" onClick={onOpenCapture}>
                <Plus size={14} /> 添加第一条记录
              </button>
            </div>
          ) : (
            <div className="inbox-empty">
              <span>
                <Search size={21} />
              </span>
              <h2>没有匹配的记录</h2>
              <p>调整搜索词或分类筛选后再试。</p>
            </div>
          )}

          <div className="inbox-conversion-note">
            <CheckSquare2 size={15} />{' '}
            转换会在同一事务中创建任务或笔记并归档来源记录；失败时不会留下半成品。
          </div>
        </section>
      )}
    </div>
  );
}

function categoryIcon(category: InboxCategory) {
  if (category === 'task') return CheckSquare2;
  if (category === 'note') return FileText;
  if (category === 'link') return Globe2;
  return Inbox;
}

function formatTimestamp(value: string): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return '时间未知';
  return new Intl.DateTimeFormat('zh-CN', {
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date);
}
