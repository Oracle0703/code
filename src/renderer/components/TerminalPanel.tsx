import { FitAddon } from '@xterm/addon-fit';
import { Terminal as XTerm } from '@xterm/xterm';
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react';
import {
  ChevronDown,
  Circle,
  Maximize2,
  Plus,
  RotateCcw,
  SquareTerminal,
  Trash2,
  X,
} from 'lucide-react';
import type {
  TerminalProfileId,
  TerminalSession,
  TerminalSnapshot,
  WorkbenchApi,
} from '../../shared/contracts';
import type { ThemeMode } from '../model';
import {
  appendPendingTerminalOutput,
  mergeTerminalSnapshot,
  moveTerminalTab,
  registerTerminalSurface,
  resolveTerminalProfile,
  type PendingTerminalOutput,
} from '../terminal-state';
import { IconButton } from './IconButton';

interface TerminalPanelProps {
  theme: ThemeMode;
  visible: boolean;
  workspaceId: string;
  onClose: () => void;
  onMaximize: () => void;
}

interface TerminalSurfaceControls {
  write(data: string): void;
  writeExit(exitCode: number): void;
  clear(): void;
  focus(): void;
  fit(): void;
}

interface TerminalOperationError {
  readonly workspaceId: string;
  readonly message: string;
}

type TerminalMutationFocus = 'surface' | 'tab';

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

export function TerminalPanel({
  theme,
  visible,
  workspaceId,
  onClose,
  onMaximize,
}: TerminalPanelProps) {
  const terminalApi = window.workbench?.terminal;
  const [snapshots, setSnapshots] = useState<ReadonlyMap<string, TerminalSnapshot>>(
    () => new Map(),
  );
  const [selectedProfiles, setSelectedProfiles] = useState<ReadonlyMap<string, TerminalProfileId>>(
    () => new Map(),
  );
  const [operationError, setOperationError] = useState<TerminalOperationError | null>(null);
  const [pendingWorkspaceIds, setPendingWorkspaceIds] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const panelRef = useRef<HTMLElement>(null);
  const requestGenerationRef = useRef(0);
  const automaticCreateAttemptsRef = useRef(new Set<string>());
  const pendingWorkspaceIdsRef = useRef(new Set<string>());
  const previousVisibleRef = useRef(false);
  const focusGenerationRef = useRef(new Map<string, number>());
  const surfaceControlsRef = useRef(new Map<string, TerminalSurfaceControls>());
  const tabElementsRef = useRef(new Map<string, HTMLButtonElement>());
  const profileSelectRef = useRef<HTMLSelectElement>(null);
  const pendingOutputRef = useRef(new Map<string, PendingTerminalOutput>());
  const lastSequenceRef = useRef(new Map<string, number>());
  const currentPanelStateRef = useRef({ workspaceId, visible });

  const applySnapshot = useCallback((snapshot: TerminalSnapshot) => {
    setSnapshots((current) => {
      const currentSnapshot = current.get(snapshot.workspaceId);
      if (currentSnapshot && snapshot.revision < currentSnapshot.revision) return current;
      const currentSessionKeys = new Set(
        snapshot.sessions.map(({ id }) => terminalSurfaceKey(snapshot.workspaceId, id)),
      );
      const workspacePrefix = `${snapshot.workspaceId}:`;
      for (const key of pendingOutputRef.current.keys()) {
        if (key.startsWith(workspacePrefix) && !currentSessionKeys.has(key)) {
          pendingOutputRef.current.delete(key);
        }
      }
      for (const key of lastSequenceRef.current.keys()) {
        if (key.startsWith(workspacePrefix) && !currentSessionKeys.has(key)) {
          lastSequenceRef.current.delete(key);
        }
      }
      return mergeTerminalSnapshot(current, snapshot);
    });
  }, []);

  const currentSnapshot = snapshots.get(workspaceId);
  const pending = pendingWorkspaceIds.has(workspaceId);
  const currentOperationError =
    operationError?.workspaceId === workspaceId ? operationError.message : null;
  const availableProfiles = useMemo(
    () => currentSnapshot?.profiles.filter(({ available }) => available) ?? [],
    [currentSnapshot?.profiles],
  );
  const selectedProfile = resolveTerminalProfile(
    currentSnapshot?.profiles ?? [],
    selectedProfiles.get(workspaceId),
  );
  const activeSession =
    currentSnapshot?.sessions.find(({ id }) => id === currentSnapshot.activeSessionId) ?? null;
  const knownSessions = useMemo(
    () => [...snapshots.values()].flatMap((snapshot) => snapshot.sessions),
    [snapshots],
  );

  const advanceWorkspaceFocusGeneration = useCallback((targetWorkspaceId: string): number => {
    const next = (focusGenerationRef.current.get(targetWorkspaceId) ?? 0) + 1;
    focusGenerationRef.current.set(targetWorkspaceId, next);
    return next;
  }, []);

  useLayoutEffect(() => {
    const previousPanelState = currentPanelStateRef.current;
    if (previousPanelState.workspaceId !== workspaceId || previousPanelState.visible !== visible) {
      advanceWorkspaceFocusGeneration(previousPanelState.workspaceId);
      advanceWorkspaceFocusGeneration(workspaceId);
    }
    currentPanelStateRef.current = { workspaceId, visible };
    if (!visible && panelRef.current?.contains(document.activeElement)) {
      (document.activeElement as HTMLElement | null)?.blur();
    }
  }, [advanceWorkspaceFocusGeneration, visible, workspaceId]);

  const beginWorkspaceOperation = useCallback((targetWorkspaceId: string): boolean => {
    if (pendingWorkspaceIdsRef.current.has(targetWorkspaceId)) return false;
    pendingWorkspaceIdsRef.current.add(targetWorkspaceId);
    setPendingWorkspaceIds((current) => {
      const next = new Set(current);
      next.add(targetWorkspaceId);
      return next;
    });
    return true;
  }, []);

  const finishWorkspaceOperation = useCallback((targetWorkspaceId: string): void => {
    if (!pendingWorkspaceIdsRef.current.delete(targetWorkspaceId)) return;
    setPendingWorkspaceIds((current) => {
      if (!current.has(targetWorkspaceId)) return current;
      const next = new Set(current);
      next.delete(targetWorkspaceId);
      return next;
    });
  }, []);

  const createDefaultSession = useCallback(
    (snapshot: TerminalSnapshot): void => {
      if (
        !terminalApi ||
        !currentPanelStateRef.current.visible ||
        currentPanelStateRef.current.workspaceId !== snapshot.workspaceId ||
        snapshot.sessions.length > 0 ||
        automaticCreateAttemptsRef.current.has(snapshot.workspaceId)
      ) {
        return;
      }
      const profile = resolveTerminalProfile(snapshot.profiles);
      if (!profile) {
        setOperationError({
          workspaceId: snapshot.workspaceId,
          message: '本机没有可用的终端 Profile。',
        });
        return;
      }
      if (!beginWorkspaceOperation(snapshot.workspaceId)) return;
      const focusGeneration = advanceWorkspaceFocusGeneration(snapshot.workspaceId);
      automaticCreateAttemptsRef.current.add(snapshot.workspaceId);
      let operation: Promise<TerminalSnapshot>;
      try {
        operation = terminalApi.create({
          workspaceId: snapshot.workspaceId,
          profileId: profile.id,
        });
      } catch {
        finishWorkspaceOperation(snapshot.workspaceId);
        setOperationError({
          workspaceId: snapshot.workspaceId,
          message: '无法启动默认终端，请选择其他 Profile 后重试。',
        });
        return;
      }
      void operation
        .then((createdSnapshot) => {
          applySnapshot(createdSnapshot);
          setOperationError((current) =>
            current?.workspaceId === createdSnapshot.workspaceId ? null : current,
          );
          if (
            createdSnapshot.activeSessionId &&
            currentPanelStateRef.current.visible &&
            currentPanelStateRef.current.workspaceId === createdSnapshot.workspaceId
          ) {
            window.requestAnimationFrame(() => {
              if (
                currentPanelStateRef.current.visible &&
                currentPanelStateRef.current.workspaceId === createdSnapshot.workspaceId &&
                focusGenerationRef.current.get(createdSnapshot.workspaceId) === focusGeneration
              ) {
                surfaceControlsRef.current
                  .get(
                    terminalSurfaceKey(
                      createdSnapshot.workspaceId,
                      createdSnapshot.activeSessionId!,
                    ),
                  )
                  ?.focus();
              }
            });
          }
        })
        .catch(() => {
          setOperationError({
            workspaceId: snapshot.workspaceId,
            message: '无法启动默认终端，请选择其他 Profile 后重试。',
          });
        })
        .finally(() => finishWorkspaceOperation(snapshot.workspaceId));
    },
    [
      advanceWorkspaceFocusGeneration,
      applySnapshot,
      beginWorkspaceOperation,
      finishWorkspaceOperation,
      terminalApi,
    ],
  );

  useEffect(() => {
    if (!terminalApi) return;
    const unsubscribeState = terminalApi.onStateChange(applySnapshot);
    const unsubscribeData = terminalApi.onData((event) => {
      const key = terminalSurfaceKey(event.workspaceId, event.sessionId);
      const previousSequence = lastSequenceRef.current.get(key) ?? 0;
      if (event.sequence <= previousSequence) return;
      lastSequenceRef.current.set(key, event.sequence);
      const controls = surfaceControlsRef.current.get(key);
      if (controls) {
        controls.write(event.data);
        return;
      }
      pendingOutputRef.current.set(
        key,
        appendPendingTerminalOutput(pendingOutputRef.current.get(key), event.data),
      );
    });
    const unsubscribeExit = terminalApi.onExit((event) => {
      const key = terminalSurfaceKey(event.workspaceId, event.sessionId);
      const controls = surfaceControlsRef.current.get(key);
      if (controls) {
        controls.writeExit(event.exitCode);
        return;
      }
      pendingOutputRef.current.set(
        key,
        appendPendingTerminalOutput(
          pendingOutputRef.current.get(key),
          `\r\n\u001b[90m进程已退出（代码 ${event.exitCode}）\u001b[0m\r\n`,
        ),
      );
    });
    return () => {
      unsubscribeState();
      unsubscribeData();
      unsubscribeExit();
    };
  }, [applySnapshot, terminalApi]);

  useEffect(() => {
    const generation = ++requestGenerationRef.current;
    if (!terminalApi || !visible) return;
    void terminalApi
      .getSnapshot({ workspaceId })
      .then((snapshot) => {
        if (
          requestGenerationRef.current !== generation ||
          !currentPanelStateRef.current.visible ||
          currentPanelStateRef.current.workspaceId !== snapshot.workspaceId
        ) {
          return;
        }
        applySnapshot(snapshot);
        setOperationError((current) => (current?.workspaceId === workspaceId ? null : current));
        createDefaultSession(snapshot);
      })
      .catch(() => {
        if (requestGenerationRef.current === generation) {
          setOperationError({
            workspaceId,
            message: '无法读取当前工作区的终端状态。',
          });
        }
      });
    return () => {
      if (requestGenerationRef.current === generation) requestGenerationRef.current += 1;
    };
  }, [applySnapshot, createDefaultSession, terminalApi, visible, workspaceId]);

  useEffect(() => {
    const panelOpened = visible && !previousVisibleRef.current;
    previousVisibleRef.current = visible;
    if (!visible || !activeSession) return;
    const frame = window.requestAnimationFrame(() => {
      surfaceControlsRef.current.get(terminalSurfaceKey(workspaceId, activeSession.id))?.fit();
      if (panelOpened) {
        surfaceControlsRef.current.get(terminalSurfaceKey(workspaceId, activeSession.id))?.focus();
      }
    });
    return () => window.cancelAnimationFrame(frame);
  }, [activeSession, visible, workspaceId]);

  const registerSurface = useCallback(
    (session: TerminalSession, controls: TerminalSurfaceControls): (() => void) => {
      const key = terminalSurfaceKey(session.workspaceId, session.id);
      return registerTerminalSurface(surfaceControlsRef.current, key, controls, () => {
        const pendingOutput = pendingOutputRef.current.get(key);
        if (!pendingOutput) return;
        if (pendingOutput.truncated) {
          controls.write('\u001b[90m[较早的终端输出已截断]\u001b[0m\r\n');
        }
        controls.write(pendingOutput.value);
        pendingOutputRef.current.delete(key);
      });
    },
    [],
  );

  const runSnapshotMutation = useCallback(
    (
      createOperation: () => Promise<TerminalSnapshot>,
      failureMessage: string,
      focusAfter: TerminalMutationFocus = 'surface',
    ): void => {
      if (!beginWorkspaceOperation(workspaceId)) return;
      const focusGeneration = advanceWorkspaceFocusGeneration(workspaceId);
      setOperationError(null);
      let operation: Promise<TerminalSnapshot>;
      try {
        operation = createOperation();
      } catch {
        finishWorkspaceOperation(workspaceId);
        setOperationError({ workspaceId, message: failureMessage });
        return;
      }
      void operation
        .then((snapshot) => {
          applySnapshot(snapshot);
          if (
            focusAfter &&
            currentPanelStateRef.current.visible &&
            currentPanelStateRef.current.workspaceId === snapshot.workspaceId
          ) {
            window.requestAnimationFrame(() => {
              if (
                !currentPanelStateRef.current.visible ||
                currentPanelStateRef.current.workspaceId !== snapshot.workspaceId ||
                focusGenerationRef.current.get(snapshot.workspaceId) !== focusGeneration
              ) {
                return;
              }
              if (focusAfter === 'tab') {
                if (snapshot.activeSessionId) {
                  tabElementsRef.current
                    .get(terminalSurfaceKey(snapshot.workspaceId, snapshot.activeSessionId))
                    ?.focus();
                } else {
                  profileSelectRef.current?.focus();
                }
              } else if (snapshot.activeSessionId) {
                surfaceControlsRef.current
                  .get(terminalSurfaceKey(snapshot.workspaceId, snapshot.activeSessionId))
                  ?.focus();
              }
            });
          }
        })
        .catch(() => setOperationError({ workspaceId, message: failureMessage }))
        .finally(() => finishWorkspaceOperation(workspaceId));
    },
    [
      advanceWorkspaceFocusGeneration,
      applySnapshot,
      beginWorkspaceOperation,
      finishWorkspaceOperation,
      workspaceId,
    ],
  );

  const runVoidMutation = useCallback(
    (createOperation: () => Promise<void>, failureMessage: string, onSuccess: () => void): void => {
      if (!beginWorkspaceOperation(workspaceId)) return;
      advanceWorkspaceFocusGeneration(workspaceId);
      setOperationError(null);
      let operation: Promise<void>;
      try {
        operation = createOperation();
      } catch {
        finishWorkspaceOperation(workspaceId);
        setOperationError({ workspaceId, message: failureMessage });
        return;
      }
      void operation
        .then(onSuccess)
        .catch(() => setOperationError({ workspaceId, message: failureMessage }))
        .finally(() => finishWorkspaceOperation(workspaceId));
    },
    [
      advanceWorkspaceFocusGeneration,
      beginWorkspaceOperation,
      finishWorkspaceOperation,
      workspaceId,
    ],
  );

  const activateSession = useCallback(
    (sessionId: string, focusAfter: TerminalMutationFocus = 'surface') => {
      if (!terminalApi || pending || pendingWorkspaceIdsRef.current.has(workspaceId)) return;
      const key = terminalSurfaceKey(workspaceId, sessionId);
      if (currentSnapshot?.activeSessionId === sessionId) {
        advanceWorkspaceFocusGeneration(workspaceId);
        if (focusAfter === 'tab') tabElementsRef.current.get(key)?.focus();
        else surfaceControlsRef.current.get(key)?.focus();
        return;
      }
      runSnapshotMutation(
        () => terminalApi.activate({ workspaceId, sessionId }),
        '无法切换终端标签。',
        focusAfter,
      );
    },
    [
      advanceWorkspaceFocusGeneration,
      currentSnapshot?.activeSessionId,
      pending,
      runSnapshotMutation,
      terminalApi,
      workspaceId,
    ],
  );

  const handleTabKeyDown = (
    event: ReactKeyboardEvent<HTMLButtonElement>,
    sessionId: string,
  ): void => {
    if (!currentSnapshot) return;
    if (
      event.key !== 'ArrowLeft' &&
      event.key !== 'ArrowRight' &&
      event.key !== 'Home' &&
      event.key !== 'End'
    ) {
      return;
    }
    event.preventDefault();
    if (pending || pendingWorkspaceIdsRef.current.has(workspaceId)) return;
    const target = moveTerminalTab(
      currentSnapshot.sessions.map(({ id }) => id),
      sessionId,
      event.key,
    );
    if (target) {
      tabElementsRef.current.get(terminalSurfaceKey(workspaceId, target))?.focus();
      activateSession(target, 'tab');
    }
  };

  const selectedProfileId = selectedProfile?.id ?? availableProfiles[0]?.id;

  return (
    <section
      ref={panelRef}
      className="terminal-panel"
      aria-label="集成终端"
      aria-hidden={!visible}
      inert={!visible}
    >
      <header className="terminal-header">
        <div className="terminal-tabs" role="tablist" aria-label="当前工作区终端会话">
          {currentSnapshot?.sessions.map((session) => {
            const active = session.id === currentSnapshot.activeSessionId;
            return (
              <div className={`terminal-tab ${active ? 'is-active' : ''}`} key={session.id}>
                <button
                  ref={(element) => {
                    const key = terminalSurfaceKey(workspaceId, session.id);
                    if (element) tabElementsRef.current.set(key, element);
                    else tabElementsRef.current.delete(key);
                  }}
                  type="button"
                  className="terminal-tab__select"
                  role="tab"
                  id={`terminal-tab-${session.id}`}
                  aria-controls={`terminal-surface-${session.id}`}
                  aria-selected={active}
                  tabIndex={active ? 0 : -1}
                  onClick={() => activateSession(session.id)}
                  onKeyDown={(event) => handleTabKeyDown(event, session.id)}
                >
                  <SquareTerminal size={14} aria-hidden="true" />
                  <span>{session.label}</span>
                  <Circle
                    size={7}
                    className={`terminal-status terminal-status--${session.status}`}
                    fill="currentColor"
                    aria-label={session.status === 'running' ? '运行中' : '已退出'}
                  />
                </button>
                <button
                  type="button"
                  className="terminal-tab__close"
                  aria-label={`关闭 ${session.label}`}
                  disabled={pending}
                  onClick={() => {
                    if (!terminalApi) return;
                    runSnapshotMutation(
                      () => terminalApi.close({ workspaceId, sessionId: session.id }),
                      '无法关闭终端标签。',
                      'tab',
                    );
                  }}
                >
                  <X size={12} aria-hidden="true" />
                </button>
              </div>
            );
          })}
        </div>
        <div className="terminal-actions">
          <label className="terminal-shell-select">
            <span className="sr-only">选择新终端 Profile</span>
            <select
              ref={profileSelectRef}
              value={selectedProfileId ?? ''}
              disabled={!terminalApi || availableProfiles.length === 0 || pending}
              onChange={(event) => {
                const profileId = event.target.value as TerminalProfileId;
                setSelectedProfiles((current) => {
                  const next = new Map(current);
                  next.set(workspaceId, profileId);
                  return next;
                });
              }}
            >
              {availableProfiles.map(({ id, label, isDefault }) => (
                <option key={id} value={id}>
                  {label}
                  {isDefault ? ' · 默认' : ''}
                </option>
              ))}
            </select>
            <ChevronDown size={12} aria-hidden="true" />
          </label>
          <IconButton
            label="新建终端"
            tooltipSide="bottom"
            disabled={!terminalApi || !selectedProfileId || pending}
            onClick={() => {
              if (!terminalApi || !selectedProfileId) return;
              runSnapshotMutation(
                () => terminalApi.create({ workspaceId, profileId: selectedProfileId }),
                '无法新建终端；请关闭不再使用的标签或选择其他 Profile。',
              );
            }}
          >
            <Plus size={15} />
          </IconButton>
          {activeSession?.status === 'exited' ? (
            <IconButton
              label="重新启动终端"
              tooltipSide="bottom"
              disabled={!terminalApi || pending}
              onClick={() => {
                if (!terminalApi) return;
                runSnapshotMutation(
                  () => terminalApi.restart({ workspaceId, sessionId: activeSession.id }),
                  '无法重新启动终端。',
                );
              }}
            >
              <RotateCcw size={14} />
            </IconButton>
          ) : null}
          <IconButton
            label="清空终端"
            tooltipSide="bottom"
            disabled={!terminalApi || !activeSession || pending}
            onClick={() => {
              if (!terminalApi || !activeSession) return;
              const key = terminalSurfaceKey(workspaceId, activeSession.id);
              runVoidMutation(
                () => terminalApi.clear({ workspaceId, sessionId: activeSession.id }),
                '无法清空终端。',
                () => surfaceControlsRef.current.get(key)?.clear(),
              );
            }}
          >
            <Trash2 size={14} />
          </IconButton>
          <IconButton label="最大化终端" tooltipSide="bottom" onClick={onMaximize}>
            <Maximize2 size={14} />
          </IconButton>
          <IconButton label="关闭终端面板" tooltipSide="left" onClick={onClose}>
            <X size={15} />
          </IconButton>
        </div>
      </header>

      <div className="terminal-surfaces">
        {knownSessions.map((session) => {
          const active =
            session.workspaceId === workspaceId && session.id === currentSnapshot?.activeSessionId;
          return (
            <TerminalSessionSurface
              key={terminalSurfaceKey(session.workspaceId, session.id)}
              session={session}
              active={active}
              panelVisible={visible}
              theme={theme}
              terminalApi={terminalApi}
              onRegister={registerSurface}
            />
          );
        })}
        {currentSnapshot?.sessions.length === 0 ? (
          <div className="terminal-empty" role="status">
            <SquareTerminal size={22} aria-hidden="true" />
            <span>{pending ? '正在启动终端…' : '当前工作区还没有终端会话'}</span>
          </div>
        ) : null}
        {!terminalApi ? (
          <div className="terminal-empty" role="status">
            <SquareTerminal size={22} aria-hidden="true" />
            <span>终端将在 Electron 桌面应用中连接本机 Shell。</span>
          </div>
        ) : null}
      </div>
      <div className="terminal-announcer" role="status" aria-live="polite">
        {currentOperationError}
      </div>
    </section>
  );
}

interface TerminalSessionSurfaceProps {
  readonly session: TerminalSession;
  readonly active: boolean;
  readonly panelVisible: boolean;
  readonly theme: ThemeMode;
  readonly terminalApi: WorkbenchApi['terminal'] | undefined;
  readonly onRegister: (session: TerminalSession, controls: TerminalSurfaceControls) => () => void;
}

function TerminalSessionSurface({
  session,
  active,
  panelVisible,
  theme,
  terminalApi,
  onRegister,
}: TerminalSessionSurfaceProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<XTerm | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const currentStateRef = useRef({ active, panelVisible, status: session.status });

  useLayoutEffect(() => {
    currentStateRef.current = { active, panelVisible, status: session.status };
  }, [active, panelVisible, session.status]);

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
        const state = currentStateRef.current;
        if (
          disposed ||
          !state.active ||
          !state.panelVisible ||
          host.clientWidth < 20 ||
          host.clientHeight < 20
        ) {
          return;
        }
        try {
          fitAddon.fit();
          if (terminalApi && state.status === 'running') {
            void terminalApi
              .resize({
                workspaceId: session.workspaceId,
                sessionId: session.id,
                columns: xterm.cols,
                rows: xterm.rows,
              })
              .catch(() => undefined);
          }
        } catch {
          // A panel transition can briefly make the terminal zero-sized.
        }
      });
    };

    const controls: TerminalSurfaceControls = {
      write: (data) => xterm.write(data),
      writeExit: (exitCode) =>
        xterm.writeln(`\r\n\u001b[90m进程已退出（代码 ${exitCode}）\u001b[0m`),
      clear: () => xterm.clear(),
      focus: () => xterm.focus(),
      fit,
    };
    const unregisterSurface = onRegister(session, controls);

    const resizeObserver = new ResizeObserver(fit);
    resizeObserver.observe(host);
    window.addEventListener('resize', fit);
    const inputSubscription = xterm.onData((data) => {
      const state = currentStateRef.current;
      if (!terminalApi || !state.active || !state.panelVisible || state.status !== 'running') {
        return;
      }
      void terminalApi
        .write({
          workspaceId: session.workspaceId,
          sessionId: session.id,
          data,
        })
        .catch(() => undefined);
    });
    fit();

    return () => {
      disposed = true;
      window.cancelAnimationFrame(animationFrame);
      resizeObserver.disconnect();
      window.removeEventListener('resize', fit);
      inputSubscription.dispose();
      unregisterSurface();
      terminalRef.current = null;
      fitAddonRef.current = null;
      xterm.dispose();
    };
    // Session identity is immutable; status/theme changes are handled through refs/effects.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onRegister, session.id, session.workspaceId, terminalApi]);

  useEffect(() => {
    if (terminalRef.current) terminalRef.current.options.theme = terminalThemes[theme];
  }, [theme]);

  useEffect(() => {
    if (!active || !panelVisible) return;
    const frame = window.requestAnimationFrame(() => {
      try {
        fitAddonRef.current?.fit();
      } catch {
        // ResizeObserver will retry after the panel layout settles.
      }
    });
    return () => window.cancelAnimationFrame(frame);
  }, [active, panelVisible]);

  return (
    <div
      ref={hostRef}
      className={`terminal-host ${active ? 'is-active' : ''}`}
      id={`terminal-surface-${session.id}`}
      role="tabpanel"
      aria-labelledby={`terminal-tab-${session.id}`}
      hidden={!active}
    />
  );
}

function terminalSurfaceKey(workspaceId: string, sessionId: string): string {
  return `${workspaceId}:${sessionId}`;
}
