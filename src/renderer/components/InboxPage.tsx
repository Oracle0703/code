import { useMemo, useState } from 'react';
import {
  Archive,
  CheckSquare2,
  FileText,
  Filter,
  Globe2,
  Inbox,
  LoaderCircle,
  Plus,
  Search,
  Sparkles,
} from 'lucide-react';
import type { InboxCategory, InboxEntry } from '../../shared/contracts';

type InboxFilter = 'all' | InboxCategory;

interface InboxPageProps {
  entries: readonly InboxEntry[];
  status: 'loading' | 'ready' | 'error';
  loadError: string | null;
  operationError: string | null;
  pendingEntryIds: ReadonlySet<string>;
  onRetry: () => void;
  onOpenCapture: () => void;
  onCategorize: (entryId: string, category: InboxCategory) => Promise<void>;
  onArchive: (entry: InboxEntry) => Promise<void>;
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
  pendingEntryIds,
  onRetry,
  onOpenCapture,
  onCategorize,
  onArchive,
}: InboxPageProps) {
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<InboxFilter>('all');
  const visibleEntries = useMemo(() => {
    const normalizedQuery = query.trim().toLocaleLowerCase();
    return entries.filter(
      (entry) =>
        (filter === 'all' || entry.category === filter) &&
        (!normalizedQuery || entry.content.toLocaleLowerCase().includes(normalizedQuery)),
    );
  }, [entries, filter, query]);

  return (
    <div className="section-page inbox-page" aria-busy={status === 'loading'}>
      <header className="section-page__header">
        <div className="section-page__title">
          <span>
            <Inbox size={20} />
          </span>
          <div>
            <h1 tabIndex={-1}>收件箱</h1>
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

          {operationError ? (
            <p className="inbox-operation-error" role="alert">
              {operationError}
            </p>
          ) : null}

          {visibleEntries.length > 0 ? (
            <ul className="inbox-list" aria-label="收件箱记录">
              {visibleEntries.map((entry) => {
                const pending = pendingEntryIds.has(entry.id);
                const Icon = categoryIcon(entry.category);
                return (
                  <li className="inbox-entry" key={entry.id}>
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
            <CheckSquare2 size={15} /> “任务线索”目前只是分类；真实任务转换将在任务模块中原子完成。
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
