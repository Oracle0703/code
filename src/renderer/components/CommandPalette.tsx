import {
  ArrowDown,
  ArrowUp,
  Bookmark,
  CalendarDays,
  CheckSquare2,
  Command as CommandIcon,
  CornerDownLeft,
  Globe2,
  Inbox,
  LoaderCircle,
  NotebookPen,
  Search,
} from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { LucideIcon } from 'lucide-react';
import type { SearchResult, SearchResultKind, SearchScope } from '../../shared/contracts';
import { SEARCH_QUERY_MIN_LENGTH, searchQueryLength } from '../../shared/search-domain';
import type { GlobalSearchController } from '../hooks/useGlobalSearchController';
import {
  commandPaletteKey,
  filterPaletteCommands,
  movePaletteSelection,
  reconcilePaletteSelection,
  searchResultGroup,
  searchResultPaletteKey,
  searchStatusMessage,
} from '../search-state';

export interface PaletteCommand {
  id: string;
  label: string;
  description?: string;
  group: string;
  icon: LucideIcon;
  shortcut?: string;
  keywords?: string;
  disabled?: boolean;
  disabledReason?: string;
  restoreFocus?: boolean;
  action: () => void | Promise<void>;
}

interface CommandPaletteProps {
  open: boolean;
  commands: readonly PaletteCommand[];
  onClose: () => void;
  searchController?: GlobalSearchController;
  currentWorkspaceId?: string;
  onSelectSearchResult?: (result: SearchResult) => void | Promise<void>;
}

interface PaletteItem {
  readonly key: string;
  readonly group: string;
  readonly label: string;
  readonly description?: string;
  readonly meta?: string;
  readonly shortcut?: string;
  readonly icon: LucideIcon;
  readonly disabled: boolean;
  readonly disabledReason?: string;
  readonly restoreFocusAfterInvoke: boolean;
  readonly invoke: () => void | Promise<void>;
}

const RESULT_ICONS: Record<SearchResultKind, LucideIcon> = {
  inbox: Inbox,
  task: CheckSquare2,
  note: NotebookPen,
  schedule: CalendarDays,
  'browser-tab': Globe2,
  'browser-bookmark': Bookmark,
};

const RESULT_KIND_LABELS: Record<SearchResultKind, string> = {
  inbox: '收件箱',
  task: '任务',
  note: '笔记',
  schedule: '日程',
  'browser-tab': '浏览器标签',
  'browser-bookmark': '浏览器收藏',
};

export function CommandPalette({
  open,
  commands,
  onClose,
  searchController,
  currentWorkspaceId = '',
  onSelectSearchResult,
}: CommandPaletteProps) {
  const [localQuery, setLocalQuery] = useState('');
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [invokingKey, setInvokingKey] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const restoreFocusRef = useRef(true);
  const invocationInFlightRef = useRef(false);
  const optionRefs = useRef(new Map<string, HTMLButtonElement>());
  const query = searchController?.query ?? localQuery;
  const setQuery = searchController?.setQuery ?? setLocalQuery;
  const filteredCommands = useMemo(() => filterPaletteCommands(commands, query), [commands, query]);

  const items = useMemo<readonly PaletteItem[]>(() => {
    const commandItems: PaletteItem[] = filteredCommands.map((command) => ({
      key: commandPaletteKey(command.id),
      group: command.group,
      label: command.label,
      description: command.description,
      shortcut: command.shortcut,
      icon: command.icon,
      disabled: command.disabled === true,
      disabledReason: command.disabledReason,
      restoreFocusAfterInvoke: command.restoreFocus ?? true,
      invoke: command.action,
    }));
    const resultItems: PaletteItem[] = (searchController?.results ?? []).map((result) => ({
      key: searchResultPaletteKey(result),
      group: searchResultGroup(result, currentWorkspaceId),
      label: result.title,
      description: result.excerpt ?? undefined,
      meta: `${RESULT_KIND_LABELS[result.kind]} · ${result.workspaceName}`,
      icon: RESULT_ICONS[result.kind],
      disabled: !onSelectSearchResult,
      disabledReason: onSelectSearchResult ? undefined : '搜索结果导航尚未连接',
      restoreFocusAfterInvoke: false,
      invoke: () => onSelectSearchResult?.(result),
    }));
    return [...commandItems, ...resultItems];
  }, [currentWorkspaceId, filteredCommands, onSelectSearchResult, searchController?.results]);

  const selectableKeys = useMemo(
    () => items.filter(({ disabled }) => !disabled).map(({ key }) => key),
    [items],
  );
  const effectiveSelectedKey = reconcilePaletteSelection(selectedKey, selectableKeys);
  const selectedItem = items.find(({ key }) => key === effectiveSelectedKey);
  const optionIds = useMemo(
    () => new Map(items.map(({ key }, index) => [key, `command-option-${index}`])),
    [items],
  );
  const groupedItems = useMemo(() => {
    const groups = new Map<string, PaletteItem[]>();
    for (const item of items) {
      const group = groups.get(item.group);
      if (group) group.push(item);
      else groups.set(item.group, [item]);
    }
    return [...groups.entries()];
  }, [items]);
  const status = searchController?.status ?? 'idle';
  const liveMessage = searchStatusMessage({
    query,
    status,
    commandCount: filteredCommands.length,
    resultCount: searchController?.results.length ?? 0,
    truncated: searchController?.truncated ?? false,
    error: searchController?.error ?? actionError,
  });
  const invoking = invokingKey !== null;
  const queryTooShort =
    query.trim().length > 0 && searchQueryLength(query.trim()) < SEARCH_QUERY_MIN_LENGTH;
  const truncatedKindLabels = (searchController?.truncatedKinds ?? [])
    .map((kind) => RESULT_KIND_LABELS[kind])
    .join('、');

  useEffect(() => {
    if (!open) return;
    const dialog = dialogRef.current;
    returnFocusRef.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    restoreFocusRef.current = true;
    if (dialog && !dialog.open) dialog.showModal();
    const frame = window.requestAnimationFrame(() => inputRef.current?.focus());
    return () => {
      window.cancelAnimationFrame(frame);
      if (dialog?.open) dialog.close();
      if (restoreFocusRef.current && returnFocusRef.current?.isConnected) {
        returnFocusRef.current.focus();
      }
      returnFocusRef.current = null;
    };
  }, [open]);

  useEffect(() => {
    if (!open || !effectiveSelectedKey) return;
    optionRefs.current.get(effectiveSelectedKey)?.scrollIntoView({ block: 'nearest' });
  }, [effectiveSelectedKey, open]);

  if (!open) return null;

  const resetPalette = () => {
    setLocalQuery('');
    searchController?.reset();
    setSelectedKey(null);
    setInvokingKey(null);
    setActionError(null);
    invocationInFlightRef.current = false;
  };

  const closePalette = (restoreFocus: boolean) => {
    if (invocationInFlightRef.current) return;
    restoreFocusRef.current = restoreFocus;
    resetPalette();
    onClose();
  };

  const runItem = async (item: PaletteItem | undefined) => {
    if (!item || item.disabled || invocationInFlightRef.current) return;
    invocationInFlightRef.current = true;
    setInvokingKey(item.key);
    setActionError(null);
    try {
      await item.invoke();
      restoreFocusRef.current = item.restoreFocusAfterInvoke;
      resetPalette();
      onClose();
    } catch (error) {
      invocationInFlightRef.current = false;
      setActionError(toActionErrorMessage(error));
      setInvokingKey(null);
      window.requestAnimationFrame(() => inputRef.current?.focus());
    }
  };

  const moveSelection = (move: 'next' | 'previous' | 'first' | 'last') => {
    setSelectedKey(movePaletteSelection(effectiveSelectedKey, selectableKeys, move));
  };

  return (
    <dialog
      ref={dialogRef}
      className="command-palette"
      aria-labelledby="command-palette-title"
      aria-describedby="command-palette-status"
      onCancel={(event) => {
        event.preventDefault();
        closePalette(true);
      }}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) closePalette(true);
      }}
      onKeyDown={(event) => {
        if ((event.ctrlKey || event.metaKey) && event.key.toLocaleLowerCase() === 'k') {
          event.preventDefault();
          closePalette(true);
          return;
        }
        if (event.key === 'Escape') {
          event.preventDefault();
          closePalette(true);
          return;
        }
        if (document.activeElement !== inputRef.current || invoking) return;
        if (event.key === 'ArrowDown') {
          event.preventDefault();
          moveSelection('next');
        } else if (event.key === 'ArrowUp') {
          event.preventDefault();
          moveSelection('previous');
        } else if (event.key === 'Home') {
          event.preventDefault();
          moveSelection('first');
        } else if (event.key === 'End') {
          event.preventDefault();
          moveSelection('last');
        } else if (event.key === 'Enter') {
          event.preventDefault();
          void runItem(selectedItem);
        }
      }}
    >
      <h2 id="command-palette-title" className="sr-only">
        搜索或运行命令
      </h2>
      <div className="command-palette__search">
        {status === 'searching' ? (
          <LoaderCircle className="is-spinning" size={18} aria-hidden="true" />
        ) : (
          <Search size={18} aria-hidden="true" />
        )}
        <label htmlFor="command-search" className="sr-only">
          搜索内容或命令
        </label>
        <input
          id="command-search"
          ref={inputRef}
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setSelectedKey(null);
            setActionError(null);
          }}
          placeholder="搜索页面、内容、操作或设置…"
          autoComplete="off"
          role="combobox"
          aria-autocomplete="list"
          aria-expanded="true"
          aria-controls="command-results"
          aria-activedescendant={
            effectiveSelectedKey ? optionIds.get(effectiveSelectedKey) : undefined
          }
          aria-keyshortcuts="Control+K Meta+K"
          disabled={invoking}
        />
        <span className="key-hint">Esc</span>
      </div>

      {searchController ? (
        <div className="command-palette__scope" role="radiogroup" aria-label="搜索范围">
          <ScopeButton
            scope="all"
            selected={searchController.scope === 'all'}
            disabled={invoking}
            onSelect={searchController.setScope}
          >
            全部工作区
          </ScopeButton>
          <ScopeButton
            scope="workspace"
            selected={searchController.scope === 'workspace'}
            disabled={invoking}
            onSelect={searchController.setScope}
          >
            当前工作区
          </ScopeButton>
        </div>
      ) : null}

      <div className="command-palette__results">
        <div
          id="command-results"
          role="listbox"
          aria-label="搜索与命令结果"
          aria-busy={status === 'searching'}
        >
          {groupedItems.map(([group, groupItems], groupIndex) => (
            <div
              className="command-result-group"
              role="group"
              aria-labelledby={`command-result-group-${groupIndex}`}
              key={group}
            >
              <p id={`command-result-group-${groupIndex}`}>{group}</p>
              {groupItems.map((item) => {
                const Icon = item.icon;
                const selected = effectiveSelectedKey === item.key;
                const itemInvoking = invokingKey === item.key;
                return (
                  <button
                    ref={(element) => {
                      if (element) optionRefs.current.set(item.key, element);
                      else optionRefs.current.delete(item.key);
                    }}
                    id={optionIds.get(item.key)}
                    type="button"
                    role="option"
                    tabIndex={-1}
                    aria-selected={selected}
                    aria-disabled={item.disabled}
                    className={`command-result ${selected ? 'is-selected' : ''}`}
                    key={item.key}
                    onPointerMove={() => {
                      if (!item.disabled && !invoking) setSelectedKey(item.key);
                    }}
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => void runItem(item)}
                  >
                    <span className="command-result__icon">
                      {itemInvoking ? (
                        <LoaderCircle className="is-spinning" size={17} aria-hidden="true" />
                      ) : (
                        <Icon size={17} aria-hidden="true" />
                      )}
                    </span>
                    <span className="command-result__copy">
                      <strong>{item.label}</strong>
                      {item.meta ? <span className="command-result__meta">{item.meta}</span> : null}
                      {item.description || item.disabledReason ? (
                        <small>{item.disabledReason ?? item.description}</small>
                      ) : null}
                    </span>
                    {item.shortcut ? <kbd>{item.shortcut}</kbd> : null}
                  </button>
                );
              })}
            </div>
          ))}
        </div>

        {items.length === 0 && status !== 'searching' && status !== 'error' ? (
          <div className="command-empty">
            <CommandIcon size={24} aria-hidden="true" />
            <strong>{queryTooShort ? '继续输入以搜索内容' : '没有找到结果'}</strong>
            <p>
              {queryTooShort
                ? `至少输入 ${SEARCH_QUERY_MIN_LENGTH} 个字符。`
                : '试试更短的关键词，或切换搜索范围。'}
            </p>
          </div>
        ) : null}
        {status === 'searching' && items.length === 0 ? (
          <div className="command-search-state">
            <LoaderCircle className="is-spinning" size={22} aria-hidden="true" />
            <span>正在搜索…</span>
          </div>
        ) : null}
        {searchController?.error || actionError ? (
          <div className="command-search-error" role="alert">
            <span>{actionError ?? searchController?.error}</span>
            {searchController?.error && searchController.canRetry ? (
              <button type="button" onClick={searchController.retry} disabled={invoking}>
                重试
              </button>
            ) : null}
          </div>
        ) : null}
        {searchController?.truncated ? (
          <p className="command-search-truncated" role="status">
            {truncatedKindLabels ? `${truncatedKindLabels}结果过多，` : '结果过多，'}
            仅显示最相关内容。请缩小关键词或搜索范围。
          </p>
        ) : null}
      </div>

      <p
        id="command-palette-status"
        className="sr-only"
        role="status"
        aria-live="polite"
        aria-atomic="true"
      >
        {liveMessage}
      </p>

      <footer className="command-palette__footer">
        <span>
          <ArrowUp size={12} aria-hidden="true" />
          <ArrowDown size={12} aria-hidden="true" /> 选择
        </span>
        <span>
          <CornerDownLeft size={12} aria-hidden="true" /> 执行
        </span>
        <span>
          <CommandIcon size={12} aria-hidden="true" /> K 随时打开
        </span>
      </footer>
    </dialog>
  );
}

interface ScopeButtonProps {
  readonly scope: SearchScope;
  readonly selected: boolean;
  readonly disabled: boolean;
  readonly onSelect: (scope: SearchScope) => void;
  readonly children: string;
}

function ScopeButton({ scope, selected, disabled, onSelect, children }: ScopeButtonProps) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      tabIndex={selected ? 0 : -1}
      data-search-scope={scope}
      className={selected ? 'is-selected' : ''}
      disabled={disabled}
      onClick={() => onSelect(scope)}
      onKeyDown={(event) => {
        if (
          !['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)
        ) {
          return;
        }
        event.preventDefault();
        const scopeGroup = event.currentTarget.parentElement;
        const nextScope =
          event.key === 'Home'
            ? 'all'
            : event.key === 'End'
              ? 'workspace'
              : scope === 'all'
                ? 'workspace'
                : 'all';
        onSelect(nextScope);
        window.requestAnimationFrame(() => {
          scopeGroup
            ?.querySelector<HTMLButtonElement>(`[data-search-scope="${nextScope}"]`)
            ?.focus();
        });
      }}
    >
      {children}
    </button>
  );
}

function toActionErrorMessage(error: unknown): string {
  if (!(error instanceof Error) || !error.message.trim()) return '操作失败，请重试。';
  return error.message.trim();
}
