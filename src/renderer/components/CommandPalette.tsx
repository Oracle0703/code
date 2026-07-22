import { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowDown, ArrowUp, Command as CommandIcon, CornerDownLeft, Search } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

export interface PaletteCommand {
  id: string;
  label: string;
  description?: string;
  group: string;
  icon: LucideIcon;
  shortcut?: string;
  keywords?: string;
  action: () => void;
}

interface CommandPaletteProps {
  open: boolean;
  commands: PaletteCommand[];
  onClose: () => void;
}

export function CommandPalette({ open, commands, onClose }: CommandPaletteProps) {
  const [query, setQuery] = useState('');
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const dialogRef = useRef<HTMLElement>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);

  const filteredCommands = useMemo(() => {
    const normalizedQuery = query.trim().toLocaleLowerCase();
    if (!normalizedQuery) return commands;
    return commands.filter((command) =>
      `${command.label} ${command.description ?? ''} ${command.keywords ?? ''}`
        .toLocaleLowerCase()
        .includes(normalizedQuery),
    );
  }, [commands, query]);
  const effectiveSelectedIndex =
    filteredCommands.length === 0 ? 0 : Math.min(selectedIndex, filteredCommands.length - 1);

  useEffect(() => {
    if (!open) return;
    returnFocusRef.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const frame = window.requestAnimationFrame(() => inputRef.current?.focus());
    return () => {
      window.cancelAnimationFrame(frame);
      returnFocusRef.current?.focus();
      returnFocusRef.current = null;
    };
  }, [open]);

  if (!open) return null;

  const closePalette = () => {
    setQuery('');
    setSelectedIndex(0);
    onClose();
  };

  const runCommand = (command: PaletteCommand | undefined) => {
    if (!command) return;
    closePalette();
    command.action();
  };

  return (
    <div
      className="command-palette-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) closePalette();
      }}
    >
      <section
        ref={dialogRef}
        className="command-palette"
        role="dialog"
        aria-modal="true"
        aria-label="命令中心"
        onKeyDown={(event) => {
          if (event.key === 'Tab') {
            const focusable = dialogRef.current?.querySelectorAll<HTMLElement>(
              'input, button:not(:disabled), [tabindex]:not([tabindex="-1"])',
            );
            const first = focusable?.[0];
            const last = focusable?.[focusable.length - 1];
            if (first && last) {
              if (event.shiftKey && document.activeElement === first) {
                event.preventDefault();
                last.focus();
              } else if (!event.shiftKey && document.activeElement === last) {
                event.preventDefault();
                first.focus();
              }
            }
          } else if (event.key === 'Escape') {
            event.preventDefault();
            closePalette();
          } else if (event.key === 'ArrowDown') {
            event.preventDefault();
            if (filteredCommands.length > 0) {
              setSelectedIndex(Math.min(effectiveSelectedIndex + 1, filteredCommands.length - 1));
            }
          } else if (event.key === 'ArrowUp') {
            event.preventDefault();
            if (filteredCommands.length > 0) {
              setSelectedIndex(Math.max(effectiveSelectedIndex - 1, 0));
            }
          } else if (event.key === 'Enter') {
            event.preventDefault();
            runCommand(filteredCommands[effectiveSelectedIndex]);
          }
        }}
      >
        <div className="command-palette__search">
          <Search size={18} aria-hidden="true" />
          <label htmlFor="command-search" className="sr-only">
            搜索命令
          </label>
          <input
            id="command-search"
            ref={inputRef}
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setSelectedIndex(0);
            }}
            placeholder="搜索页面、操作或设置…"
            autoComplete="off"
            role="combobox"
            aria-expanded="true"
            aria-controls="command-results"
            aria-activedescendant={
              filteredCommands[effectiveSelectedIndex]
                ? `command-option-${filteredCommands[effectiveSelectedIndex].id}`
                : undefined
            }
          />
          <span className="key-hint">Esc</span>
        </div>

        <div className="command-palette__results" id="command-results" role="listbox">
          {filteredCommands.length ? (
            filteredCommands.map((command, index) => {
              const Icon = command.icon;
              const showGroup = index === 0 || filteredCommands[index - 1].group !== command.group;
              return (
                <div className="command-result-group" key={command.id}>
                  {showGroup ? <p>{command.group}</p> : null}
                  <button
                    id={`command-option-${command.id}`}
                    type="button"
                    role="option"
                    aria-selected={effectiveSelectedIndex === index}
                    className={`command-result ${effectiveSelectedIndex === index ? 'is-selected' : ''}`}
                    onMouseMove={() => setSelectedIndex(index)}
                    onClick={() => runCommand(command)}
                  >
                    <span className="command-result__icon">
                      <Icon size={17} />
                    </span>
                    <span className="command-result__copy">
                      <strong>{command.label}</strong>
                      {command.description ? <small>{command.description}</small> : null}
                    </span>
                    {command.shortcut ? <kbd>{command.shortcut}</kbd> : null}
                  </button>
                </div>
              );
            })
          ) : (
            <div className="command-empty">
              <CommandIcon size={24} />
              <strong>没有找到命令</strong>
              <p>试试“浏览器”“任务”或“主题”。</p>
            </div>
          )}
        </div>

        <footer className="command-palette__footer">
          <span>
            <ArrowUp size={12} />
            <ArrowDown size={12} /> 选择
          </span>
          <span>
            <CornerDownLeft size={12} /> 执行
          </span>
          <span>
            <CommandIcon size={12} /> K 随时打开
          </span>
        </footer>
      </section>
    </div>
  );
}
