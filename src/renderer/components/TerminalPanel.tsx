import { FitAddon } from '@xterm/addon-fit';
import { Terminal as XTerm } from '@xterm/xterm';
import { useEffect, useRef, useState } from 'react';
import { ChevronDown, Circle, Maximize2, Plus, SquareTerminal, Trash2, X } from 'lucide-react';
import type { TerminalShell } from '../../shared/contracts';
import type { ThemeMode } from '../model';
import { IconButton } from './IconButton';

interface TerminalPanelProps {
  theme: ThemeMode;
  visible: boolean;
  onClose: () => void;
  onMaximize: () => void;
}

const shellLabels: Record<TerminalShell, string> = {
  default: '默认 Shell',
  powershell: 'PowerShell',
  cmd: 'Command Prompt',
  wsl: 'WSL',
  bash: 'Bash',
  zsh: 'Zsh',
};

const terminalThemes = {
  dark: {
    background: '#101116',
    foreground: '#d7dae3',
    cursor: '#9d8cff',
    cursorAccent: '#101116',
    selectionBackground: '#7568d94f',
    black: '#1b1d25',
    red: '#ff7a8a',
    green: '#62d6a7',
    yellow: '#f3c977',
    blue: '#78b4ff',
    magenta: '#b49cff',
    cyan: '#64d4dc',
    white: '#d7dae3',
    brightBlack: '#6f7380',
    brightWhite: '#ffffff',
  },
  light: {
    background: '#f8f8fb',
    foreground: '#32343d',
    cursor: '#6958d8',
    cursorAccent: '#f8f8fb',
    selectionBackground: '#7668d938',
    black: '#32343d',
    red: '#c94c60',
    green: '#208b68',
    yellow: '#a86c14',
    blue: '#3378c5',
    magenta: '#7657cf',
    cyan: '#16818a',
    white: '#f1f1f4',
    brightBlack: '#757783',
    brightWhite: '#ffffff',
  },
} as const;

export function TerminalPanel({ theme, visible, onClose, onMaximize }: TerminalPanelProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<XTerm | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const sessionIdRef = useRef<string | null>(null);
  const [sessionLabel, setSessionLabel] = useState(() =>
    window.workbench?.terminal ? '终端' : '预览终端',
  );
  const [sessionStatus, setSessionStatus] = useState<'starting' | 'running' | 'exited'>(() =>
    window.workbench?.terminal ? 'starting' : 'running',
  );
  const [shell, setShell] = useState<TerminalShell>('default');
  const [generation, setGeneration] = useState(0);
  const terminalApi = window.workbench?.terminal;

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    let disposed = false;
    let animationFrame = 0;
    const xterm = new XTerm({
      allowProposedApi: false,
      convertEol: true,
      cursorBlink: true,
      cursorStyle: 'bar',
      fontFamily: '"Cascadia Code", "SFMono-Regular", Consolas, monospace',
      fontSize: 13,
      fontWeight: '400',
      lineHeight: 1.25,
      scrollback: 5000,
      theme: terminalThemes[theme],
    });
    const fitAddon = new FitAddon();
    xterm.loadAddon(fitAddon);
    xterm.open(host);
    terminalRef.current = xterm;
    fitAddonRef.current = fitAddon;

    const fit = () => {
      window.cancelAnimationFrame(animationFrame);
      animationFrame = window.requestAnimationFrame(() => {
        if (disposed || host.clientWidth < 20 || host.clientHeight < 20) return;
        try {
          fitAddon.fit();
          const sessionId = sessionIdRef.current;
          if (terminalApi && sessionId) {
            void terminalApi.resize(sessionId, xterm.cols, xterm.rows);
          }
        } catch {
          // The terminal may briefly be zero-sized while a panel is collapsing.
        }
      });
    };

    const resizeObserver = new ResizeObserver(fit);
    resizeObserver.observe(host);
    window.addEventListener('resize', fit);

    const dataSubscription = terminalApi?.onData((event) => {
      if (event.id === sessionIdRef.current) xterm.write(event.data);
    });
    const exitSubscription = terminalApi?.onExit((event) => {
      if (event.id !== sessionIdRef.current) return;
      setSessionStatus('exited');
      xterm.writeln(`\r\n\x1b[90m进程已退出（代码 ${event.exitCode}）\x1b[0m`);
    });
    const inputSubscription = xterm.onData((data) => {
      const sessionId = sessionIdRef.current;
      if (terminalApi && sessionId) void terminalApi.write(sessionId, data);
    });

    if (terminalApi) {
      void terminalApi
        .create({ shell })
        .then((session) => {
          if (disposed) {
            void terminalApi.close(session.id);
            return;
          }
          sessionIdRef.current = session.id;
          setSessionLabel(shellLabels[session.shell]);
          setSessionStatus('running');
          fit();
          xterm.focus();
        })
        .catch((error: unknown) => {
          setSessionStatus('exited');
          xterm.writeln('\x1b[31m无法启动终端会话。\x1b[0m');
          if (error instanceof Error) xterm.writeln(`\x1b[90m${error.message}\x1b[0m`);
        });
    } else {
      xterm.writeln('\x1b[1;35mDaily Workbench\x1b[0m');
      xterm.writeln('\x1b[90m终端将在 Electron 桌面应用中连接本机 Shell。\x1b[0m');
      xterm.write('\r\n\x1b[32m›\x1b[0m ');
    }

    fit();

    return () => {
      disposed = true;
      window.cancelAnimationFrame(animationFrame);
      resizeObserver.disconnect();
      window.removeEventListener('resize', fit);
      dataSubscription?.();
      exitSubscription?.();
      inputSubscription.dispose();
      const sessionId = sessionIdRef.current;
      sessionIdRef.current = null;
      if (terminalApi && sessionId) void terminalApi.close(sessionId);
      terminalRef.current = null;
      fitAddonRef.current = null;
      xterm.dispose();
    };
    // Theme changes are applied independently so they do not restart the shell.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [generation, shell, terminalApi]);

  useEffect(() => {
    if (terminalRef.current) terminalRef.current.options.theme = terminalThemes[theme];
  }, [theme]);

  useEffect(() => {
    if (!visible) return;
    const frame = window.requestAnimationFrame(() => {
      try {
        fitAddonRef.current?.fit();
        terminalRef.current?.focus();
      } catch {
        // The opening animation will trigger a subsequent ResizeObserver update.
      }
    });
    return () => window.cancelAnimationFrame(frame);
  }, [visible]);

  return (
    <section className="terminal-panel" aria-label="集成终端" aria-hidden={!visible}>
      <header className="terminal-header">
        <div className="terminal-tabs" role="tablist" aria-label="终端会话">
          <button
            type="button"
            className="terminal-tab is-active"
            role="tab"
            aria-selected="true"
            onClick={() => terminalRef.current?.focus()}
          >
            <SquareTerminal size={14} aria-hidden="true" />
            <span>{sessionLabel}</span>
            <Circle
              size={7}
              className={`terminal-status terminal-status--${sessionStatus}`}
              fill="currentColor"
              aria-label={
                sessionStatus === 'running'
                  ? '运行中'
                  : sessionStatus === 'starting'
                    ? '启动中'
                    : '已退出'
              }
            />
          </button>
        </div>
        <div className="terminal-actions">
          <label className="terminal-shell-select">
            <span className="sr-only">选择 Shell</span>
            <select
              value={shell}
              onChange={(event) => {
                setSessionStatus('starting');
                setShell(event.target.value as TerminalShell);
              }}
            >
              {Object.entries(shellLabels).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
            <ChevronDown size={12} aria-hidden="true" />
          </label>
          <IconButton
            label="新建终端"
            tooltipSide="bottom"
            onClick={() => {
              setSessionStatus('starting');
              setSessionLabel('终端');
              setGeneration((value) => value + 1);
            }}
          >
            <Plus size={15} />
          </IconButton>
          <IconButton
            label="清空终端"
            tooltipSide="bottom"
            onClick={() => terminalRef.current?.clear()}
          >
            <Trash2 size={14} />
          </IconButton>
          <IconButton label="最大化终端" tooltipSide="bottom" onClick={onMaximize}>
            <Maximize2 size={14} />
          </IconButton>
          <IconButton label="关闭终端" tooltipSide="left" onClick={onClose}>
            <X size={15} />
          </IconButton>
        </div>
      </header>
      <div className="terminal-host" ref={hostRef} onClick={() => terminalRef.current?.focus()} />
    </section>
  );
}
